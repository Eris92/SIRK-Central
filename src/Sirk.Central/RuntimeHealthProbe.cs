namespace Sirk.Central;

internal static class RuntimeHealthProbe
{
    private const string Command = "--health-check";
    private static readonly Uri DefaultUri = new("http://127.0.0.1:8080/readyz");

    public static bool IsRequested(string[] arguments) =>
        arguments.Length > 0 && string.Equals(arguments[0], Command, StringComparison.Ordinal);

    public static async Task<int> RunAsync(
        string[] arguments,
        CancellationToken cancellationToken = default)
    {
        if (!TryResolveUri(arguments, out var uri, out var error))
        {
            Console.Error.WriteLine(error);
            return 64;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        using var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false
        };
        using var client = new HttpClient(handler)
        {
            Timeout = Timeout.InfiniteTimeSpan
        };

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            using var response = await client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                timeout.Token);
            if ((int)response.StatusCode is >= 200 and <= 299)
            {
                Console.WriteLine("healthy");
                return 0;
            }

            Console.Error.WriteLine($"unhealthy: HTTP {(int)response.StatusCode}");
            return 1;
        }
        catch (OperationCanceledException)
        {
            Console.Error.WriteLine("unhealthy: timeout");
            return 1;
        }
        catch (HttpRequestException exception)
        {
            Console.Error.WriteLine($"unhealthy: {exception.HttpRequestError}");
            return 1;
        }
    }

    private static bool TryResolveUri(
        string[] arguments,
        out Uri uri,
        out string error)
    {
        uri = DefaultUri;
        error = string.Empty;

        if (arguments.Length > 2)
        {
            error = "Usage: --health-check [http://127.0.0.1:PORT/PATH]";
            return false;
        }

        if (arguments.Length == 2 &&
            (!Uri.TryCreate(arguments[1], UriKind.Absolute, out uri) || uri is null))
        {
            error = "Health-check URL is invalid.";
            return false;
        }

        if (uri.Scheme is not (Uri.UriSchemeHttp or Uri.UriSchemeHttps) ||
            !uri.IsLoopback ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment))
        {
            error = "Health-check URL must be a loopback HTTP(S) URL without credentials, query or fragment.";
            return false;
        }

        return true;
    }
}
