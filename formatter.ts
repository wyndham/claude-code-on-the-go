/**
 * Converts Claude's markdown output to Slack's mrkdwn format.
 * Slack uses a subset of markdown with some differences.
 */
export function formatForSlack(text: string): string {
  if (!text) return "";

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
