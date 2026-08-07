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

    public static bool Contains(this string value, char character, StringComparison comparisonType)
    {
        return comparisonType switch
        {
            StringComparison.Ordinal => value.IndexOf(character) >= 0,
            StringComparison.OrdinalIgnoreCase => value.IndexOf(char.ToUpperInvariant(character)) >= 0 ||
                                                  value.IndexOf(char.ToLowerInvariant(character)) >= 0,
            _ => value.IndexOf(character.ToString(), comparisonType) >= 0
        };
    }
}
