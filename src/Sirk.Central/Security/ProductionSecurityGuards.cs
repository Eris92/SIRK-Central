using System.Collections.Concurrent;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Security;

internal static class ProductionSecurityGuards
{
    public static IDataProtectionBuilder ConfigureDataProtection(
        IServiceCollection services,
        SecurityOptions options,
        IHostEnvironment environment)
    {
        var builder = services.AddDataProtection().SetApplicationName("SIRK Central .NET 10");
        if (!options.Enabled) return builder;

        var keyDirectory = Path.Combine(options.DataRoot, options.DataProtectionDirectoryName);
        Directory.CreateDirectory(keyDirectory);
        SecureDirectory(keyDirectory);
        builder.PersistKeysToFileSystem(new DirectoryInfo(keyDirectory));

        if (!string.IsNullOrWhiteSpace(options.DataProtectionCertificatePath))
        {
            var certificate = LoadCertificate(options);
            builder.ProtectKeysWithCertificate(certificate);
            services.AddSingleton(certificate);
            return builder;
        }

        if (options.RequireProtectedDataProtectionKeys && !environment.IsDevelopment())
            throw new InvalidOperationException(
                "Production startup refused: configure Sirk:Security:DataProtectionCertificatePath and " +
                "DataProtectionCertificatePasswordFile to encrypt the Data Protection key ring at rest.");

        return builder;
    }

    private static X509Certificate2 LoadCertificate(SecurityOptions options)
    {
        var certificatePath = Path.GetFullPath(options.DataProtectionCertificatePath);
        ValidateProtectedFile(certificatePath, 1024 * 1024, "Data Protection certificate");

        string? password = null;
        if (!string.IsNullOrWhiteSpace(options.DataProtectionCertificatePasswordFile))
        {
            var passwordPath = Path.GetFullPath(options.DataProtectionCertificatePasswordFile);
            ValidateProtectedFile(passwordPath, 4096, "certificate password");
            password = File.ReadAllText(passwordPath).TrimEnd('\r', '\n');
            if (password.Length is < 16 or > 512)
                throw new InvalidDataException("Certificate password must contain 16-512 characters.");
        }

        var certificate = X509CertificateLoader.LoadPkcs12FromFile(
            certificatePath,
            password,
            X509KeyStorageFlags.EphemeralKeySet | X509KeyStorageFlags.Exportable);

        if (!certificate.HasPrivateKey)
        {
            certificate.Dispose();
            throw new InvalidDataException("Data Protection certificate does not contain a private key.");
        }
        if (certificate.NotAfter.ToUniversalTime() <= DateTime.UtcNow.AddDays(30))
        {
            certificate.Dispose();
            throw new InvalidDataException("Data Protection certificate expires in less than 30 days.");
        }
        return certificate;
    }

    private static void ValidateProtectedFile(string path, long maximumBytes, string description)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length is <= 0 || info.Length > maximumBytes)
            throw new InvalidDataException($"{description} file is missing, empty or too large: {path}");
        if (!OperatingSystem.IsWindows())
        {
            var mode = File.GetUnixFileMode(path);
            var forbidden = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
                            UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
            if ((mode & forbidden) != 0)
                throw new InvalidDataException($"{description} file permissions must be 0600: {path}");
        }
    }

    private static void SecureDirectory(string path)
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }
}

internal sealed class SingleWriterLease : IDisposable
{
    private static readonly ConcurrentDictionary<string, byte> ProcessLeases =
        new(StringComparer.OrdinalIgnoreCase);

    private readonly FileStream? _lease;
    private readonly bool _rangeLocked;
    private readonly string? _path;
    private int _disposed;

    public SingleWriterLease(IOptions<SecurityOptions> options)
    {
        var value = options.Value;
        if (!value.Enabled || !value.RequireSingleWriterLease) return;

        Directory.CreateDirectory(value.DataRoot);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(value.DataRoot, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

        var fileName = ValidateFileName(value.WriterLeaseFileName);
        _path = Path.GetFullPath(Path.Combine(value.DataRoot, fileName));
        if (!ProcessLeases.TryAdd(_path, 0))
            throw new InvalidOperationException(
                "SIRK Central storage is already owned by another writer in this process.");

        try
        {
            _lease = new FileStream(_path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read, 4096,
                FileOptions.WriteThrough);
            if (!OperatingSystem.IsMacOS())
            {
                _lease.Lock(0, 1);
                _rangeLocked = true;
            }
            _lease.SetLength(0);
            using var writer = new StreamWriter(_lease, leaveOpen: true);
            writer.Write($"pid={Environment.ProcessId}\nstartedUtc={DateTimeOffset.UtcNow:O}\n");
            writer.Flush();
            _lease.Flush(true);
            _lease.Position = 0;
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(_path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            _lease?.Dispose();
            ProcessLeases.TryRemove(_path, out _);
            throw new InvalidOperationException(
                "SIRK Central storage is already owned by another writer. File-backed storage supports exactly one active instance.",
                exception);
        }
        catch
        {
            _lease?.Dispose();
            ProcessLeases.TryRemove(_path, out _);
            throw;
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        if (_lease is not null)
        {
            if (_rangeLocked && !OperatingSystem.IsMacOS())
            {
                try { _lease.Unlock(0, 1); }
                catch (IOException) { }
            }
            _lease.Dispose();
        }
        if (_path is not null) ProcessLeases.TryRemove(_path, out _);
    }

    private static string ValidateFileName(string value)
    {
        var result = (value ?? string.Empty).Trim();
        if (result.Length is < 3 or > 100 || result != Path.GetFileName(result) || result.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new InvalidDataException("Writer lease file name is invalid.");
        return result;
    }
}
