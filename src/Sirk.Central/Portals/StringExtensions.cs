namespace Sirk.Central.Portals;

internal static class StringExtensions
{
    public static bool StartsWith(
        this string value,
        char prefix,
        StringComparison comparison) =>
        value.StartsWith(prefix.ToString(), comparison);
}
