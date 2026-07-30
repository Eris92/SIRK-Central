"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_POLICIES = Object.freeze({ sessionHours:8, requireReauthenticationForSensitiveActions:true, privilegedRoleApproval:true, alertOnBreakGlassUse:true, emergencyMode:false, blockNewPortalConnections:false });

function create(options) {
  const dataDir=path.resolve(options.dataDir), storePath=path.join(dataDir,"security-center.json");
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  function empty(){return{schema:1,policies:{...DEFAULT_POLICIES},audit:[],incidents:[],breakGlass:{lastUsedAtUtc:null,lastUsedIp:null,lastRotatedAtUtc:null,reviewedAtUtc:null,reviewedBy:null}};}
  function read(){if(!fs.existsSync(storePath))return empty();const value=JSON.parse(fs.readFileSync(storePath,"utf8"));value.schema=1;value.policies=Object.assign({},DEFAULT_POLICIES,value.policies||{});value.audit=Array.isArray(value.audit)?value.audit:[];value.incidents=Array.isArray(value.incidents)?value.incidents:[];value.breakGlass=Object.assign(empty().breakGlass,value.breakGlass||{});return value;}
  function write(value){const temp=storePath+".tmp-"+process.pid+"-"+Date.now();fs.writeFileSync(temp,JSON.stringify(value,null,2)+"\n",{mode:0o600});fs.renameSync(temp,storePath);}
  function actorName(actor){return actor&&(actor.identityKey||actor.username||actor.displayName)||"system";}
  function audit(event,actor,details){const value=read();value.audit.unshift({id:"audit-"+Date.now()+"-"+Math.random().toString(16).slice(2),atUtc:new Date().toISOString(),event,actor:actorName(actor),role:actor&&(actor.builtIn?"BreakGlass":actor.role)||null,details:details||{}});value.audit=value.audit.slice(0,5000);write(value);}
  function listAudit(limit){return read().audit.slice(0,Math.max(1,Math.min(1000,Number(limit)||200)));}
  function policies(){return read().policies;}
  function updatePolicies(input,actor){const value=read(),next=Object.assign({},value.policies);if(input.sessionHours!==undefined)next.sessionHours=Math.max(1,Math.min(24,Number(input.sessionHours)||8));for(const key of["requireReauthenticationForSensitiveActions","privilegedRoleApproval","alertOnBreakGlassUse","emergencyMode","blockNewPortalConnections"])if(input[key]!==undefined)next[key]=Boolean(input[key]);value.policies=next;write(value);audit("security.policies.updated",actor,next);return next;}
  function recordBreakGlassUse(ip,actor){const value=read();value.breakGlass.lastUsedAtUtc=new Date().toISOString();value.breakGlass.lastUsedIp=String(ip||"");write(value);audit("breakglass.signed_in",actor,{ip:String(ip||"")});}
  function recordBreakGlassRotation(actor){const value=read();value.breakGlass.lastRotatedAtUtc=new Date().toISOString();write(value);audit("breakglass.access_rotated",actor,{});}
  function breakGlassStatus(){return read().breakGlass;}
  function markBreakGlassReviewed(actor){const value=read();value.breakGlass.reviewedAtUtc=new Date().toISOString();value.breakGlass.reviewedBy=actorName(actor);write(value);audit("breakglass.reviewed",actor,{});return value.breakGlass;}
  function incidents(){return read().incidents;}
  function createIncident(input,actor){const value=read(),incident={id:"inc-"+Date.now()+"-"+Math.random().toString(16).slice(2),title:String(input.title||"Security incident").trim().slice(0,160),severity:["low","medium","high","critical"].includes(input.severity)?input.severity:"medium",status:"open",description:String(input.description||"").trim().slice(0,4000),createdAtUtc:new Date().toISOString(),createdBy:actorName(actor)};value.incidents.unshift(incident);write(value);audit("incident.created",actor,{incidentId:incident.id,severity:incident.severity});return incident;}
  function updateIncident(id,input,actor){const value=read(),incident=value.incidents.find(x=>x.id===id);if(!incident)throw new Error("Incident not found.");if(input.status)incident.status=["open","contained","resolved"].includes(input.status)?input.status:incident.status;if(input.severity)incident.severity=["low","medium","high","critical"].includes(input.severity)?input.severity:incident.severity;incident.updatedAtUtc=new Date().toISOString();incident.updatedBy=actorName(actor);write(value);audit("incident.updated",actor,{incidentId:id,status:incident.status,severity:incident.severity});return incident;}
  return{audit,listAudit,policies,updatePolicies,recordBreakGlassUse,recordBreakGlassRotation,breakGlassStatus,markBreakGlassReviewed,incidents,createIncident,updateIncident};
}
module.exports={create,DEFAULT_POLICIES};
