"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { verifySecret, verifyAccessKey, randomToken, hashAccessKey } = require("./security");
const { verify: verifySsoTicket } = require("./sso-ticket");
const { permissionsFor, hasPermission, ASSIGNABLE_ROLES, ROLE_PERMISSIONS } = require("./rbac");
const portalStoreFactory = require("./portal-store");
const userStoreFactory = require("./user-store");
const providerStoreFactory = require("./identity-provider-store");
const accessStoreFactory = require("./access-store");
const tunnelBrokerFactory = require("./tunnel-broker");
const securityCenterFactory = require("./security-center-store");

function loadConfig(env) {
    const config = {
        bindHost: env.SIRK_BIND_HOST || "127.0.0.1",
        port: Number(env.SIRK_PORT || 8080),
        publicOrigin: String(env.SIRK_PUBLIC_ORIGIN || "").replace(/\/+$/, ""),
        authOrigin: String(env.SIRK_AUTH_ORIGIN || "").replace(/\/+$/, ""),
        ssoSharedSecret: String(env.SIRK_SSO_SHARED_SECRET || ""),
        adminUsername: env.SIRK_ADMIN_USERNAME || "admin",
        adminPasswordHash: env.SIRK_ADMIN_PASSWORD_HASH || "",
        accessKeyHash: env.SIRK_ACCESS_KEY_HASH || "",
        dataDir: path.resolve(env.SIRK_DATA_DIR || path.join(process.cwd(), "data")),
        sessionHours: Math.max(1, Math.min(24, Number(env.SIRK_SESSION_HOURS || 8))),
        env
    };
    if (!config.publicOrigin.startsWith("https://") && env.NODE_ENV === "production") throw new Error("SIRK_PUBLIC_ORIGIN must use HTTPS in production.");
    if (!config.adminPasswordHash.startsWith("scrypt$")) throw new Error("SIRK_ADMIN_PASSWORD_HASH is required.");
    if (!config.accessKeyHash.startsWith("sha256$")) throw new Error("SIRK_ACCESS_KEY_HASH is required.");
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("SIRK_PORT is invalid.");
    if ((config.authOrigin && !config.ssoSharedSecret) || (!config.authOrigin && config.ssoSharedSecret)) throw new Error("SIRK_AUTH_ORIGIN and SIRK_SSO_SHARED_SECRET must be configured together.");
    return config;
}

function createApp(config) {
    const portalStore = portalStoreFactory.create({ dataDir: config.dataDir });
    const userStore = userStoreFactory.create({ dataDir: config.dataDir });
    const providerStore = providerStoreFactory.create({ dataDir: config.dataDir, authOrigin: config.authOrigin, env: config.env || process.env });
    const accessStore = accessStoreFactory.create({ dataDir: config.dataDir });
    const securityCenter = securityCenterFactory.create({ dataDir: config.dataDir });
    const broker = tunnelBrokerFactory.create();
    const sessions = new Map(), loginFailures = new Map(), usedSsoTickets = new Map();
    const webRoot = path.join(__dirname, "..", "public");
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

    function json(res, status, body, headers) {
        const data = Buffer.from(JSON.stringify(body));
        res.writeHead(status, Object.assign({ "Content-Type":"application/json; charset=utf-8", "Content-Length":data.length, "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" }, headers || {}));
        res.end(data);
    }
    function redirect(res, location, headers) { res.writeHead(302, Object.assign({ Location:location, "Cache-Control":"no-store", "Content-Length":"0" }, headers || {})); res.end(); }
    function parseCookies(req) { const result={}; for(const part of String(req.headers.cookie||"").split(";")){const i=part.indexOf("=");if(i>0)result[part.slice(0,i).trim()]=part.slice(i+1).trim();} return result; }
    function requestIp(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim(); }
    function session(req) {
        const token=parseCookies(req).sirk_central_session, value=token&&sessions.get(token);
        if(!value||value.expiresAt<Date.now()){if(token)sessions.delete(token);return null;}
        value.lastSeenAt=Date.now();
        return value;
    }
    function currentSessionToken(req){return parseCookies(req).sirk_central_session||"";}
    function effectiveSessionHours(){return Math.max(1,Math.min(24,Number(securityCenter.policies().sessionHours)||config.sessionHours));}
    function createSession(identity, req) {
        const token=randomToken(32), now=Date.now(), hours=effectiveSessionHours();
        sessions.set(token,Object.assign({},identity,{permissions:permissionsFor(identity.role,identity.builtIn),createdAt:now,lastSeenAt:now,expiresAt:now+hours*3600000,ip:req?requestIp(req):"",userAgent:req?String(req.headers["user-agent"]||"").slice(0,300):""}));
        return token;
    }
    function invalidateIdentitySessions(identityKey){for(const[token,value]of sessions)if(value.identityKey===identityKey)sessions.delete(token);}
    function sessionCookie(token){return "sirk_central_session="+token+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age="+(effectiveSessionHours()*3600);}
    function sameOrigin(req){const origin=String(req.headers.origin||"");return !origin||origin===config.publicOrigin;}
    function bearerCredential(req){const m=String(req.headers.authorization||"").match(/^Bearer ([A-Za-z0-9_-]+)$/);return m?m[1]:"";}
    function effectiveSecurity(){const overrides=userStore.securityOverrides();return{passwordHash:overrides.breakGlassPasswordHash||config.adminPasswordHash,accessKeyHash:overrides.accessKeyHash||config.accessKeyHash};}
    function requireSession(req,res){const value=session(req);if(!value)json(res,401,{ok:false,error:"Authentication required."});return value;}
    function requirePermission(req,res,permission){const value=requireSession(req,res);if(!value)return null;if(!hasPermission(value,permission)){json(res,403,{ok:false,error:"Permission denied."});return null;}return value;}
    function requirePortalCapability(req,res,portalId,capability){const actor=requireSession(req,res);if(!actor)return null;const effective=accessStore.effective(actor,portalId);if(!effective.allowed||effective.capabilities[capability]==="deny"){json(res,403,{ok:false,error:"Portal access denied by team or local policy."});return null;}if(effective.capabilities[capability]==="approval"){json(res,409,{ok:false,error:"This operation requires approval.",approvalRequired:true});return null;}return{actor,effective};}
    function readBody(req,limit){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on("data",c=>{size+=c.length;if(size>limit){reject(Object.assign(new Error("Request body is too large."),{statusCode:413}));req.destroy();}else chunks.push(c);});req.on("end",()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}"));}catch(_){reject(Object.assign(new Error("Invalid JSON body."),{statusCode:400}));}});req.on("error",reject);});}
    function portalCredentials(req){const m=String(req.headers.authorization||"").match(/^SIRK-Portal ([A-Za-z0-9_-]+)$/);if(!m)return null;try{const decoded=Buffer.from(m[1],"base64url").toString("utf8"),i=decoded.indexOf(":");return i<1?null:{id:decoded.slice(0,i),token:decoded.slice(i+1)};}catch(_){return null;}}
    function portalCookies(req){return String(req.headers.cookie||"").split(";").map(v=>v.trim()).filter(v=>v&&!/^sirk_central_session=/i.test(v)).join("; ");}
    function rewriteLocation(value,prefix){value=String(value||"");if(!value)return"";if(value.startsWith("/"))return prefix+value;try{const parsed=new URL(value);return prefix+parsed.pathname+parsed.search+parsed.hash;}catch(_){return value;}}
    function rewriteSetCookie(values,prefix){return(Array.isArray(values)?values:[]).map(value=>{const parts=String(value).split(";").map(p=>p.trim()).filter(p=>!/^domain=/i.test(p)&&!/^path=/i.test(p));parts.push("Path="+prefix+"/");return parts.join("; ");});}
    function rewritePortalBody(body,contentType,prefix){if(!/^(?:text\/|application\/(?:javascript|json))/i.test(String(contentType||"")))return body;let text=body.toString("utf8");text=text.replace(/(["'`])\/(?!\/)/g,(_,q)=>q+prefix+"/");text=text.replace(/(\b(?:href|src|action)=)\/(?!\/)/gi,(_,a)=>a+prefix+"/");text=text.replace(/(url\(\s*)\/(?!\/)/gi,(_,o)=>o+prefix+"/");return Buffer.from(text);}
    function publicSessions(){return[...sessions.entries()].map(([token,value])=>({id:token.slice(0,12),token,username:value.username,displayName:value.displayName,identityKey:value.identityKey||null,source:value.source,role:value.builtIn?"BreakGlass":value.role,status:value.status||"active",ip:value.ip||"",userAgent:value.userAgent||"",createdAtUtc:new Date(value.createdAt).toISOString(),lastSeenAtUtc:new Date(value.lastSeenAt).toISOString(),expiresAtUtc:new Date(value.expiresAt).toISOString()}));}

    async function handler(req,res){try{const url=new URL(req.url,"http://central.local");
        if(req.method==="GET"&&url.pathname==="/healthz")return json(res,200,{ok:true});
        if(req.method==="GET"&&url.pathname==="/auth/sso/callback"){
            if(!config.authOrigin)return json(res,404,{ok:false,error:"Not found."});
            for(const[jti,expiresAt]of usedSsoTickets)if(expiresAt<Date.now())usedSsoTickets.delete(jti);
            const ticket=verifySsoTicket(url.searchParams.get("ticket"),config.ssoSharedSecret,{issuer:config.authOrigin,audience:config.publicOrigin});
            if(usedSsoTickets.has(ticket.jti))throw Object.assign(new Error("SSO ticket was already used."),{statusCode:401});
            usedSsoTickets.set(ticket.jti,ticket.exp*1000);
            const identityKey=ticket.tid+":"+ticket.oid,state=userStore.resolveEntra(identityKey,{username:ticket.username,displayName:ticket.name},ticket.roles);
            const identity={username:ticket.username||ticket.name,displayName:ticket.name,identityKey,tenantId:ticket.tid,objectId:ticket.oid,source:"entra",role:state.role,status:state.status,requestedRole:state.requestedRole,claimedRoles:state.claimedRoles,roleSource:state.roleSource,builtIn:false};
            const token=createSession(identity,req);securityCenter.audit("authentication.entra.success",identity,{ip:requestIp(req),claimedRoles:state.claimedRoles,status:state.status});
            return redirect(res,"/",{"Set-Cookie":sessionCookie(token)});
        }
        if(req.method==="GET"&&url.pathname==="/api/access"){if(!verifyAccessKey(bearerCredential(req),effectiveSecurity().accessKeyHash))return json(res,404,{ok:false,error:"Not found."});return json(res,200,{ok:true});}
        if(req.method==="POST"&&url.pathname==="/api/login"){
            if(!verifyAccessKey(bearerCredential(req),effectiveSecurity().accessKeyHash))return json(res,404,{ok:false,error:"Not found."});
            if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});
            const address=requestIp(req),failure=loginFailures.get(address);if(failure&&failure.blockedUntil>Date.now())return json(res,429,{ok:false,error:"Too many login attempts. Try again later."});
            const body=await readBody(req,16384);let identity=null;
            if(String(body.username||"")===config.adminUsername&&verifySecret(String(body.password||""),effectiveSecurity().passwordHash))identity={username:config.adminUsername,displayName:config.adminUsername,source:"local",role:"BreakGlass",builtIn:true,status:"active"};
            else identity=userStore.authenticateLocal(body.username,body.password);
            if(!identity){const attempts=failure&&failure.expiresAt>Date.now()?failure.attempts+1:1;loginFailures.set(address,{attempts,expiresAt:Date.now()+900000,blockedUntil:attempts>=5?Date.now()+900000:0});securityCenter.audit("authentication.local.failure",null,{username:String(body.username||""),ip:address});return json(res,401,{ok:false,error:"Invalid username or password."});}
            loginFailures.delete(address);const token=createSession(identity,req);securityCenter.audit("authentication.local.success",identity,{ip:address});if(identity.builtIn)securityCenter.recordBreakGlassUse(address,identity);
            return json(res,200,Object.assign({ok:true},identity,{permissions:permissionsFor(identity.role,identity.builtIn)}),{"Set-Cookie":sessionCookie(token)});
        }
        if(req.method==="POST"&&url.pathname==="/api/logout"){const token=currentSessionToken(req),value=token&&sessions.get(token);if(value)securityCenter.audit("authentication.logout",value,{});if(token)sessions.delete(token);return json(res,200,{ok:true,logoutUrl:value&&value.source==="entra"&&config.authOrigin?config.authOrigin+"/logout":""},{"Set-Cookie":"sirk_central_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"});}
        if(req.method==="GET"&&url.pathname==="/api/session"){const value=session(req);return json(res,value?200:401,value?{ok:true,username:value.username,displayName:value.displayName,source:value.source,identityKey:value.identityKey,role:value.role,status:value.status,requestedRole:value.requestedRole,claimedRoles:value.claimedRoles||[],roleSource:value.roleSource,builtIn:Boolean(value.builtIn),permissions:value.permissions}:{ok:false,error:"Authentication required."});}

        if(req.method==="GET"&&url.pathname==="/api/settings/roles"){if(!requireSession(req,res))return;return json(res,200,{ok:true,roles:ASSIGNABLE_ROLES,permissions:ROLE_PERMISSIONS});}
        if(req.method==="GET"&&url.pathname==="/api/settings/users"){const actor=requirePermission(req,res,"users.manage");if(!actor)return;return json(res,200,{ok:true,users:userStore.listUsers(actor)});}
        if(req.method==="POST"&&url.pathname==="/api/settings/users"){const actor=requirePermission(req,res,"users.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const user=userStore.createLocalUser(await readBody(req,32768),actor);securityCenter.audit("user.local.created",actor,{username:user.username,role:user.role});return json(res,201,{ok:true,user});}
        const roleMatch=url.pathname.match(/^\/api\/settings\/users\/(local|entra)\/(.+)\/role$/);
        if(roleMatch&&req.method==="PATCH"){const actor=requirePermission(req,res,"users.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const key=decodeURIComponent(roleMatch[2]),body=await readBody(req,16384),result=userStore.updateRole({source:roleMatch[1],key},body.role,actor);if(roleMatch[1]==="entra")invalidateIdentitySessions(key);securityCenter.audit("role.changed",actor,{source:roleMatch[1],key,role:body.role});return json(res,200,{ok:true,result});}
        const approvalMatch=url.pathname.match(/^\/api\/settings\/users\/entra\/(.+)\/(approve|reject)$/);
        if(approvalMatch&&req.method==="POST"){const actor=requirePermission(req,res,"users.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const key=decodeURIComponent(approvalMatch[1]),action=approvalMatch[2],result=action==="approve"?userStore.approveEntraRole(key,actor):userStore.rejectEntraRole(key,actor);invalidateIdentitySessions(key);securityCenter.audit("role.privileged."+action,actor,{identityKey:key,role:result.role||result.requestedRole});return json(res,200,{ok:true,result});}
        if(req.method==="GET"&&url.pathname==="/api/settings/identity-provider"){const actor=requireSession(req,res);if(!actor)return;return json(res,200,{ok:true,provider:providerStore.publicView(),editable:hasPermission(actor,"identity.manage"),securityEditable:hasPermission(actor,"security.manage")});}
        if(req.method==="PUT"&&url.pathname==="/api/settings/identity-provider"){const actor=requirePermission(req,res,"identity.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const provider=providerStore.update(await readBody(req,65536),{allowSecurity:hasPermission(actor,"security.manage")});securityCenter.audit("identity.entra.updated",actor,{tenant:provider.tenant,enabled:provider.enabled,clientId:provider.clientId});return json(res,200,{ok:true,provider});}
        if(req.method==="POST"&&url.pathname==="/api/settings/identity-provider/test"){const actor=requirePermission(req,res,"identity.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const provider=providerStore.read();if(!provider.enabled)return json(res,400,{ok:false,error:"Microsoft Entra login is disabled."});const metadataUrl="https://login.microsoftonline.com/"+encodeURIComponent(provider.tenant)+"/v2.0/.well-known/openid-configuration",response=await fetch(metadataUrl,{headers:{accept:"application/json"}});if(!response.ok)return json(res,502,{ok:false,error:"Unable to read Entra OpenID metadata."});const metadata=await response.json();securityCenter.audit("identity.entra.tested",actor,{tenant:provider.tenant});return json(res,200,{ok:true,issuer:metadata.issuer,authorizationEndpoint:metadata.authorization_endpoint,tokenEndpoint:metadata.token_endpoint});}

        if(req.method==="GET"&&url.pathname==="/api/security/overview"){const actor=requirePermission(req,res,"security.manage");if(!actor)return;const users=userStore.listUsers(actor),pending=users.filter(x=>x.source==="entra"&&x.requestedRole);return json(res,200,{ok:true,pendingRoles:pending,sessions:publicSessions(),policies:securityCenter.policies(),breakGlass:securityCenter.breakGlassStatus(),incidents:securityCenter.incidents(),audit:securityCenter.listAudit(50)});}
        if(req.method==="GET"&&url.pathname==="/api/security/sessions"){if(!requirePermission(req,res,"security.sessions"))return;return json(res,200,{ok:true,sessions:publicSessions()});}
        const sessionMatch=url.pathname.match(/^\/api\/security\/sessions\/([A-Za-z0-9_-]+)$/);
        if(sessionMatch&&req.method==="DELETE"){const actor=requirePermission(req,res,"security.sessions");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const id=sessionMatch[1],entry=[...sessions.entries()].find(([token])=>token===id||token.startsWith(id));if(!entry)return json(res,404,{ok:false,error:"Session not found."});if(entry[0]===currentSessionToken(req))return json(res,409,{ok:false,error:"Use Sign out to close your current session."});sessions.delete(entry[0]);securityCenter.audit("session.revoked",actor,{username:entry[1].username,identityKey:entry[1].identityKey||null,sessionId:entry[0].slice(0,12)});return json(res,200,{ok:true});}
        if(req.method==="POST"&&url.pathname==="/api/security/sessions/revoke-all"){const actor=requirePermission(req,res,"security.sessions");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const own=currentSessionToken(req);for(const token of [...sessions.keys()])if(token!==own)sessions.delete(token);securityCenter.audit("sessions.revoked_all",actor,{});return json(res,200,{ok:true});}
        if(req.method==="GET"&&url.pathname==="/api/security/policies"){if(!requirePermission(req,res,"security.policies"))return;return json(res,200,{ok:true,policies:securityCenter.policies()});}
        if(req.method==="PUT"&&url.pathname==="/api/security/policies"){const actor=requirePermission(req,res,"security.policies");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});return json(res,200,{ok:true,policies:securityCenter.updatePolicies(await readBody(req,32768),actor)});}
        if(req.method==="GET"&&url.pathname==="/api/security/audit"){if(!requirePermission(req,res,"audit.read"))return;return json(res,200,{ok:true,events:securityCenter.listAudit(url.searchParams.get("limit"))});}
        if(req.method==="GET"&&url.pathname==="/api/security/break-glass"){if(!requirePermission(req,res,"security.manage"))return;return json(res,200,{ok:true,status:securityCenter.breakGlassStatus()});}
        if(req.method==="POST"&&url.pathname==="/api/security/break-glass/review"){const actor=requirePermission(req,res,"security.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});return json(res,200,{ok:true,status:securityCenter.markBreakGlassReviewed(actor)});}
        if(req.method==="GET"&&url.pathname==="/api/security/incidents"){if(!requirePermission(req,res,"security.incidents"))return;return json(res,200,{ok:true,incidents:securityCenter.incidents()});}
        if(req.method==="POST"&&url.pathname==="/api/security/incidents"){const actor=requirePermission(req,res,"security.incidents");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});return json(res,201,{ok:true,incident:securityCenter.createIncident(await readBody(req,32768),actor)});}
        const incidentMatch=url.pathname.match(/^\/api\/security\/incidents\/(inc-[A-Za-z0-9-]+)$/);
        if(incidentMatch&&req.method==="PATCH"){const actor=requirePermission(req,res,"security.incidents");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});return json(res,200,{ok:true,incident:securityCenter.updateIncident(incidentMatch[1],await readBody(req,16384),actor)});}

        if(req.method==="GET"&&url.pathname==="/api/access-control"){const actor=requirePermission(req,res,"access.manage");if(!actor)return;return json(res,200,{ok:true,teams:accessStore.listTeams(),users:userStore.listUsers(actor),portals:portalStore.list(),capabilities:accessStoreFactory.CAPABILITIES});}
        if(req.method==="POST"&&url.pathname==="/api/access-control/teams"){const actor=requirePermission(req,res,"access.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const team=accessStore.saveTeam(await readBody(req,131072));securityCenter.audit("access.team.saved",actor,{teamId:team.id});return json(res,200,{ok:true,team});}
        const teamMatch=url.pathname.match(/^\/api\/access-control\/teams\/([a-z0-9-]+)$/);
        if(teamMatch&&req.method==="DELETE"){const actor=requirePermission(req,res,"access.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});accessStore.deleteTeam(teamMatch[1]);securityCenter.audit("access.team.deleted",actor,{teamId:teamMatch[1]});return json(res,200,{ok:true});}
        const policyMatch=url.pathname.match(/^\/api\/access-control\/portals\/([a-z0-9-]+)\/policy$/);
        if(policyMatch&&req.method==="GET"){if(!requirePermission(req,res,"access.manage"))return;return json(res,200,{ok:true,policy:accessStore.portalPolicy(policyMatch[1])});}
        if(policyMatch&&req.method==="PUT"){const actor=requirePermission(req,res,"access.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const policy=accessStore.setPortalPolicy(policyMatch[1],(await readBody(req,131072)).policy);securityCenter.audit("access.portal_policy.updated",actor,{portalId:policyMatch[1]});return json(res,200,{ok:true,policy});}
        if(req.method==="POST"&&url.pathname==="/api/access-control/simulate"){const actor=requirePermission(req,res,"access.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const body=await readBody(req,16384);return json(res,200,{ok:true,result:accessStore.simulate(body.memberKey,portalStore.list(),userStore.listUsers(actor))});}

        if(req.method==="POST"&&url.pathname==="/api/break-glass/password"){const actor=requireSession(req,res);if(!actor)return;if(!actor.builtIn)return json(res,403,{ok:false,error:"Break-Glass account required."});const body=await readBody(req,16384);if(!verifySecret(String(body.currentPassword||""),effectiveSecurity().passwordHash))return json(res,401,{ok:false,error:"Current password is invalid."});userStore.setBreakGlassPassword(body.newPassword);securityCenter.audit("breakglass.password.changed",actor,{});return json(res,200,{ok:true});}
        if(req.method==="POST"&&url.pathname==="/api/break-glass/access"){const actor=requireSession(req,res);if(!actor)return;if(!actor.builtIn)return json(res,403,{ok:false,error:"Break-Glass account required."});const key=randomToken(32);userStore.setAccessKeyHash(hashAccessKey(key));securityCenter.recordBreakGlassRotation(actor);return json(res,200,{ok:true,accessUrl:config.publicOrigin+"/#access="+key});}

        if(url.pathname==="/api/portals"&&req.method==="GET"){const actor=requirePermission(req,res,"portals.read");if(!actor)return;const visible=broker.list(portalStore.list()).filter(portal=>accessStore.effective(actor,portal.id).allowed).map(portal=>Object.assign({},portal,{access:accessStore.effective(actor,portal.id)}));return json(res,200,{ok:true,portals:visible});}
        if(url.pathname==="/api/portals"&&req.method==="POST"){const actor=requirePermission(req,res,"portals.manage");if(!actor)return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const portal=portalStore.createPortal(await readBody(req,16384));securityCenter.audit("portal.created",actor,{portalId:portal.id});return json(res,201,{ok:true,portal});}
        const connectMatch=url.pathname.match(/^\/api\/portals\/([a-z0-9-]+)\/connect$/);
        if(connectMatch&&req.method==="POST"){const actor=requirePermission(req,res,"portals.connect");if(!actor)return;if(securityCenter.policies().emergencyMode||securityCenter.policies().blockNewPortalConnections)return json(res,423,{ok:false,error:"New Portal connections are blocked by the Central security policy."});if(!requirePortalCapability(req,res,connectMatch[1],"portal.connect"))return;if(!sameOrigin(req))return json(res,403,{ok:false,error:"Origin rejected."});const response=await broker.request(connectMatch[1],{kind:"portal-info"});securityCenter.audit("portal.connected",actor,{portalId:connectMatch[1]});return json(res,200,{ok:true,portal:response.portal,url:"/connect/"+connectMatch[1]+"/"});}
        const proxyMatch=url.pathname.match(/^\/connect\/([a-z0-9-]+)(\/.*)?$/);
        if(proxyMatch){if(!requirePermission(req,res,"portals.connect"))return;if(securityCenter.policies().emergencyMode||securityCenter.policies().blockNewPortalConnections)return json(res,423,{ok:false,error:"Portal connections are blocked by the Central security policy."});if(!requirePortalCapability(req,res,proxyMatch[1],"portal.connect"))return;const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8388608)throw Object.assign(new Error("Request body is too large."),{statusCode:413});chunks.push(chunk);}const response=await broker.request(proxyMatch[1],{method:req.method,path:(proxyMatch[2]||"/")+url.search,headers:{accept:req.headers.accept||"*/*","content-type":req.headers["content-type"]||"",cookie:portalCookies(req),origin:req.headers.origin||"",host:req.headers.host||"","accept-language":req.headers["accept-language"]||"","x-sirk-csrf":req.headers["x-sirk-csrf"]||""},bodyBase64:Buffer.concat(chunks).toString("base64")});const prefix="/connect/"+proxyMatch[1],contentType=response.contentType||"application/octet-stream",responseBody=rewritePortalBody(Buffer.from(response.bodyBase64||"","base64"),contentType,prefix),headers={"Content-Type":contentType,"Content-Length":responseBody.length,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"frame-ancestors 'none'; object-src 'none'; base-uri 'self'"};const location=rewriteLocation(response.location,prefix),setCookie=rewriteSetCookie(response.setCookie,prefix);if(location)headers.Location=location;if(setCookie.length)headers["Set-Cookie"]=setCookie;res.writeHead(Number(response.statusCode)||502,headers);res.end(responseBody);return;}

        const staticFiles=new Set(["/","/app.js","/i18n.js","/styles.css","/permissions-layout.js","/permissions-layout.css"]);
        if(req.method==="GET"&&staticFiles.has(url.pathname)){const fileName=url.pathname==="/"?"index.html":url.pathname.slice(1),contentType=fileName.endsWith(".html")?"text/html; charset=utf-8":fileName.endsWith(".js")?"text/javascript; charset=utf-8":"text/css; charset=utf-8",data=fs.readFileSync(path.join(webRoot,fileName));res.writeHead(200,{"Content-Type":contentType,"Content-Length":data.length,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(data);return;}
        return json(res,404,{ok:false,error:"Not found."});
    }catch(error){return json(res,error.statusCode||400,{ok:false,error:error.message||"Internal server error."});}}

    const server=http.createServer(handler);
    server.on("upgrade",(req,socket,head)=>{const url=new URL(req.url,"http://central.local");if(url.pathname!=="/tunnel")return socket.destroy();const credentials=portalCredentials(req),portal=credentials&&portalStore.authenticate(credentials.id,credentials.token);if(!portal){socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");return socket.destroy();}wsServer.handleUpgrade(req,socket,head,webSocket=>broker.attach(portal,webSocket));});
    return{server,store:portalStore,userStore,providerStore,accessStore,securityCenter,broker};
}

if(require.main===module){const config=loadConfig(process.env),app=createApp(config);app.server.listen(config.port,config.bindHost,()=>process.stdout.write("SIRK Central listening on "+config.bindHost+":"+config.port+"\n"));}
module.exports={loadConfig,createApp};
