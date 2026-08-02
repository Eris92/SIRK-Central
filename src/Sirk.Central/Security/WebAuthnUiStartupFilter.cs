using System.Text;
using Microsoft.Extensions.Options;
using Sirk.Central.Operations;

namespace Sirk.Central.Security;

internal sealed class WebAuthnUiStartupFilter : IStartupFilter
{
    private readonly IWebHostEnvironment _environment;
    private readonly OperationsMiddleware _operations;

    public WebAuthnUiStartupFilter(IWebHostEnvironment environment, IOptions<SecurityOptions> options)
    {
        _environment = environment;
        _operations = new OperationsMiddleware(options);
    }

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use(async (context, continuation) =>
        {
            if (await _operations.TryHandleAsync(context)) return;

            if (!HttpMethods.IsGet(context.Request.Method) ||
                !context.Request.Path.Equals("/app.js", StringComparison.Ordinal))
            {
                await continuation();
                return;
            }

            var file = _environment.WebRootFileProvider.GetFileInfo("app.js");
            if (!file.Exists)
            {
                await continuation();
                return;
            }

            context.Response.ContentType = "text/javascript; charset=utf-8";
            context.Response.Headers.CacheControl = "no-cache, no-store, must-revalidate";
            await using var stream = file.CreateReadStream();
            await stream.CopyToAsync(context.Response.Body, context.RequestAborted);
            await context.Response.WriteAsync(
                "\nvoid import('/webauthn.js');\n",
                Encoding.UTF8,
                context.RequestAborted);
        });
        next(app);
    };
}
