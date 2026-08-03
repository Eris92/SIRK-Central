using System.Collections.Concurrent;

namespace Sirk.Central.Security;

internal sealed record FailedLoginThrottleResult(
    bool Blocked,
    int RemainingAttempts,
    TimeSpan RetryAfter);

internal static class FailedLoginThrottle
{
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(5);
    private static readonly ConcurrentDictionary<string, FailureBucket> Buckets =
        new(StringComparer.Ordinal);

    public static FailedLoginThrottleResult Check(
        string remoteAddress,
        string userName,
        int maximumFailures)
    {
        maximumFailures = Math.Clamp(maximumFailures, 1, 100);
        var key = Key(remoteAddress, userName);
        if (!Buckets.TryGetValue(key, out var bucket))
            return new FailedLoginThrottleResult(false, maximumFailures, TimeSpan.Zero);

        lock (bucket.Sync)
        {
            var now = DateTimeOffset.UtcNow;
            RemoveExpired(bucket, now);
            if (bucket.Failures.Count == 0)
            {
                Buckets.TryRemove(new KeyValuePair<string, FailureBucket>(key, bucket));
                return new FailedLoginThrottleResult(false, maximumFailures, TimeSpan.Zero);
            }

            var blocked = bucket.Failures.Count >= maximumFailures;
            var retryAfter = blocked
                ? Window - (now - bucket.Failures.Peek())
                : TimeSpan.Zero;
            if (retryAfter < TimeSpan.Zero) retryAfter = TimeSpan.Zero;
            return new FailedLoginThrottleResult(
                blocked,
                Math.Max(0, maximumFailures - bucket.Failures.Count),
                retryAfter);
        }
    }

    public static FailedLoginThrottleResult RecordFailure(
        string remoteAddress,
        string userName,
        int maximumFailures)
    {
        maximumFailures = Math.Clamp(maximumFailures, 1, 100);
        var key = Key(remoteAddress, userName);
        var bucket = Buckets.GetOrAdd(key, static _ => new FailureBucket());
        lock (bucket.Sync)
        {
            var now = DateTimeOffset.UtcNow;
            RemoveExpired(bucket, now);
            bucket.Failures.Enqueue(now);
            var blocked = bucket.Failures.Count >= maximumFailures;
            var retryAfter = blocked
                ? Window - (now - bucket.Failures.Peek())
                : TimeSpan.Zero;
            return new FailedLoginThrottleResult(
                blocked,
                Math.Max(0, maximumFailures - bucket.Failures.Count),
                retryAfter);
        }
    }

    public static void Reset(string remoteAddress, string userName) =>
        Buckets.TryRemove(Key(remoteAddress, userName), out _);

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
