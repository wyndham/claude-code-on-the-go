/**
 * Converts Claude's markdown output to Slack's mrkdwn format.
 * Slack uses a subset of markdown with some differences.
 */
export function formatForSlack(text: string): string {
  if (!text) return "";

  // Convert markdown tables before other transforms (but not inside code blocks)
  text = convertTablesOutsideCodeBlocks(text);

  return (
    text
      // Code blocks: ```lang\n...\n``` → ```\n...\n``` (Slack ignores lang)
      .replace(/```[\w]*\n/g, "```\n")
      // Bold: **text** → *text*
      .replace(/\*\*(.*?)\*\*/g, "*$1*")
      // Italic: *text* stays as-is in Slack (but not if already bold)
      // Headers: ## Heading → *Heading* (Slack has no headers)
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
      // Horizontal rules
      .replace(/^---+$/gm, "─────────────────")
      // Trim excessive blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Finds markdown tables outside of code blocks and converts them to Slack-friendly format.
 */
function convertTablesOutsideCodeBlocks(text: string): string {
  // Split by code fences, only transform non-code segments
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => (i % 2 === 0 ? convertTables(part) : part))
    .join("");
}

/**
 * Converts markdown tables in a text segment to Slack-readable format.
 * 2-column tables → "*Key:* Value" list
 * 3+ column tables → aligned lines with bold headers
 */
function convertTables(text: string): string {
  const TABLE_LINE = /^\s*\|.*\|\s*$/;
  const SEPARATOR = /^\s*\|[\s\-:|]+\|\s*$/;

  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect start of a table (need at least header + separator + 1 data row)
    if (TABLE_LINE.test(lines[i]) && i + 2 < lines.length && SEPARATOR.test(lines[i + 1])) {
      const headers = parseCells(lines[i]);
      i += 2; // skip header + separator

      const rows: string[][] = [];
      while (i < lines.length && TABLE_LINE.test(lines[i]) && !SEPARATOR.test(lines[i])) {
        rows.push(parseCells(lines[i]));
        i++;
      }

      if (headers.length === 2) {
        // 2-column → "*Key:* Value" list
        for (const row of rows) {
          result.push(`• *${row[0]}:* ${row[1] || ""}`);
        }
      } else {
        // 3+ columns → header line then indented rows
        result.push(`*${headers.join("  |  ")}*`);
        for (const row of rows) {
          result.push(`  ${row.join("  |  ")}`);
        }
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

function parseCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}
