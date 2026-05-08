/**
 * Shared shapes for the v3 librarian's exploration scouts.
 *
 * Each scout (topic / source / entity / cite) is a runAgentWithTools session
 * that explores one slice of the vault and returns SurfacedPage entries.
 * The reviewer downstream consumes the union of scout outputs.
 */

export interface SurfacedPage {
  /** Vault-relative path the scout looked at. e.g. 'wiki/topics/llm-tool-use.md'. */
  path: string;
  /** Short relevant excerpt (≤ ~400 chars) from the page, in the scout's words
   *  or quoted. Lets the reviewer see content without re-fetching. */
  excerpt: string;
  /** One sentence on why the scout thinks this is relevant to the article. */
  relevanceNote: string;
}

export interface ScoutOutput {
  surfacedPages: SurfacedPage[];
  /** When the scout's LLM call failed, throw was caught, or JSON parse failed. */
  error?: string;
  /** How many tool rounds the scout used. Useful for cost telemetry. */
  toolRounds?: number;
}
