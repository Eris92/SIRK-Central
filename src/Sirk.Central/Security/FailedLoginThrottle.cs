using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace Sirk.Central.Security;

internal sealed record FailedLoginThrottleResult(
    bool Blocked,
    int RemainingAttempts,
    TimeSpan RetryAfter);

internal sealed class FailedLoginThrottle
{
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(5);
    private readonly ConcurrentDictionary<string, FailureBucket> _buckets =
        new(StringComparer.Ordinal);
    private readonly int _maximumFailures;

    public FailedLoginThrottle(IOptions<SecurityOptions> options)
    {
        _maximumFailures = Math.Clamp(
            options.Value.LoginAttemptsPerFiveMinutes,
            1,
            100);
    }

    public FailedLoginThrottleResult Check(string remoteAddress, string userName)
    {
        var key = Key(remoteAddress, userName);
        if (!_buckets.TryGetValue(key, out var bucket))
            return new FailedLoginThrottleResult(false, _maximumFailures, TimeSpan.Zero);

        lock (bucket.Sync)
        {
            RemoveExpired(bucket, DateTimeOffset.UtcNow);
            if (bucket.Failures.Count == 0)
            {
                _buckets.TryRemove(new KeyValuePair<string, FailureBucket>(key, bucket));
                return new FailedLoginThrottleResult(false, _maximumFailures, TimeSpan.Zero);
            }

            var blocked = bucket.Failures.Count >= _maximumFailures;
            var retryAfter = blocked
                ? Window - (DateTimeOffset.UtcNow - bucket.Failures.Peek())
                : TimeSpan.Zero;
            if (retryAfter < TimeSpan.Zero) retryAfter = TimeSpan.Zero;
            return new FailedLoginThrottleResult(
                blocked,
                Math.Max(0, _maximumFailures - bucket.Failures.Count),
                retryAfter);
        }
    }

    public FailedLoginThrottleResult RecordFailure(
        string remoteAddress,
        string userName)
    {
        var key = Key(remoteAddress, userName);
        var bucket = _buckets.GetOrAdd(key, static _ => new FailureBucket());
        lock (bucket.Sync)
        {
            var now = DateTimeOffset.UtcNow;
            RemoveExpired(bucket, now);
            bucket.Failures.Enqueue(now);
            var blocked = bucket.Failures.Count >= _maximumFailures;
            var retryAfter = blocked
                ? Window - (now - bucket.Failures.Peek())
                : TimeSpan.Zero;
            return new FailedLoginThrottleResult(
                blocked,
                Math.Max(0, _maximumFailures - bucket.Failures.Count),
                retryAfter);
        }
    }

    public void Reset(string remoteAddress, string userName) =>
        _buckets.TryRemove(Key(remoteAddress, userName), out _);

    private static void RemoveExpired(FailureBucket bucket, DateTimeOffset now)
    {
        while (bucket.Failures.Count > 0 &&
               now - bucket.Failures.Peek() >= Window)
        {
            bucket.Failures.Dequeue();
        }
    }

    private static string Key(string remoteAddress, string userName) =>
        string.Concat(
            Normalize(remoteAddress, 128),
            "\n",
            Normalize(userName, 64).ToLowerInvariant());

    private static string Normalize(string? value, int maximum)
    {
        var normalized = (value ?? "unknown").Trim();
        if (normalized.Length == 0) normalized = "unknown";
        if (normalized.Length > maximum) normalized = normalized[..maximum];
        return normalized;
    }

    private sealed class FailureBucket
    {
        public object Sync { get; } = new();
        public Queue<DateTimeOffset> Failures { get; } = new();
    }
}
