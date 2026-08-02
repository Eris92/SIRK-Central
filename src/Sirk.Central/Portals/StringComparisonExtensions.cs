namespace Sirk.Central.Portals;

internal static class StringComparisonExtensions
{
    public static bool StartsWith(this string value, char character, StringComparison comparisonType)
    {
        if (value.Length == 0) return false;
        return comparisonType switch
        {
            StringComparison.Ordinal => value[0] == character,
            StringComparison.OrdinalIgnoreCase => char.ToUpperInvariant(value[0]) == char.ToUpperInvariant(character),
            _ => string.Compare(value, 0, character.ToString(), 0, 1, comparisonType) == 0
        };
    }
}
