using System.Text.Json;
using System.Text.Json.Serialization;

namespace Sirk.Central.Updates;

internal sealed record UpdateSignature(
    [property: JsonPropertyName("algorithm")] string Algorithm,
    [property: JsonPropertyName("keyId")] string KeyId,
    [property: JsonPropertyName("value")] string Value);

internal sealed record TrustedKeyDocument(
    [property: JsonPropertyName("keys")] IReadOnlyList<TrustedKeyEntry> Keys);

internal sealed record TrustedKeyEntry(
    [property: JsonPropertyName("keyId")] string KeyId,
    [property: JsonPropertyName("publicKeyPem")] string PublicKeyPem);

internal static class JsonDefaults
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}

internal static class CanonicalUpdateJson
{
    public static byte[] SerializeWithoutTopLevelSignature<T>(T value)
    {
        var root = JsonSerializer.SerializeToElement(value, JsonDefaults.Options);
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            WriteObject(root, writer, topLevel: true);
            writer.Flush();
        }
        return output.ToArray();
    }

    private static void WriteObject(JsonElement root, Utf8JsonWriter writer, bool topLevel)
    {
        writer.WriteStartObject();
        foreach (var property in root.EnumerateObject()
                     .Where(property => !(topLevel && property.NameEquals("signature")))
                     .OrderBy(property => property.Name, StringComparer.Ordinal))
        {
            writer.WritePropertyName(property.Name);
            WriteElement(property.Value, writer);
        }
        writer.WriteEndObject();
    }

    private static void WriteElement(JsonElement element, Utf8JsonWriter writer)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                WriteObject(element, writer, topLevel: false);
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray()) WriteElement(item, writer);
                writer.WriteEndArray();
                break;
            default:
                element.WriteTo(writer);
                break;
        }
    }
}
