// Stdio MCP server exposing the screenshotter pipeline as a single tool,
// `capture_website`. Bundled with the Claude Code plugin (see .mcp.json).
//
// CRITICAL: a stdio MCP server speaks JSON-RPC over stdout. We must NEVER write
// anything but JSON-RPC to stdout — no console.log, no banner, nothing. All
// diagnostics (including the pipeline's progress logs) go to stderr via
// console.error. picocolors auto-disables ANSI on non-TTY, so stderr stays
// plain text.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// Import zod via its `zod/v3` subpath: the MCP SDK's registerTool generics are
// typed against `zod/v3` internally. Importing from the bare `zod` entry (which
// in zod 3.25 multiplexes v3/v4 types) yields a structurally divergent
// ZodTypeAny and triggers TS2589 / AnySchema mismatches at registerTool. Using
// the same v3 entry the SDK uses keeps the schema types aligned.
import { z } from 'zod/v3';
import { buildRunConfig } from '../config';
import { run } from '../pipeline';

const server = new McpServer({ name: 'screenshotter', version: '0.1.0' });

server.registerTool(
  'capture_website',
  {
    description:
      'Capture full-page screenshots of a website plus an auto-extracted ' +
      'typography.md (font families, type scale, colors), bundled into a zip. ' +
      'Returns the path to the generated zip, the output directory, and counts ' +
      'of captured/failed pages. Use `authFile` to capture gated sites with a ' +
      'saved session from `screenshotter login`.',
    inputSchema: {
      url: z
        .string()
        .describe('Website URL to capture, e.g. "https://huggingface.co".'),
      mode: z
        .enum(['web', 'mobile'])
        .optional()
        .describe('Viewport profile: "web" (desktop, default) or "mobile".'),
      pages: z
        .array(z.string())
        .optional()
        .describe(
          'Explicit paths/URLs to capture (e.g. ["/", "/pricing"]); ' +
            'skips auto-discovery when provided.',
        ),
      maxPages: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Maximum number of pages to capture (default 25, or 150 when subLinks is true).',
        ),
      depth: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Maximum crawl depth for the generic crawler / sub-link hops (default 2).'),
      subLinks: z
        .boolean()
        .optional()
        .describe(
          'Also follow + capture same-origin links inside discovered pages (default false). ' +
            'Sub-pages inherit their parent category and the same extract/api/full treatment.',
        ),
      maxSubLinksPerPage: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Cap on links followed per page when subLinks is true (default 25).'),
      concurrency: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Number of pages captured in parallel (default 4).'),
      zip: z
        .boolean()
        .optional()
        .describe('Whether to produce the final zip (default true).'),
      authFile: z
        .string()
        .optional()
        .describe(
          'Path to a saved storageState JSON from `screenshotter login`, ' +
            'used to capture authenticated/gated sites.',
        ),
      captureApi: z
        .boolean()
        .optional()
        .describe(
          'Also capture network/API traffic → OpenAPI spec + endpoint catalog ' +
            '+ HAR (secrets redacted), written to the api/ folder.',
        ),
      apiSameOrigin: z
        .boolean()
        .optional()
        .describe('Restrict API capture to the site\'s own origin/subdomains.'),
      interact: z
        .boolean()
        .optional()
        .describe(
          'With captureApi: drive safe interactions (scroll/search/tabs/pagination) ' +
            'to provoke first-party API calls. Default true.',
        ),
      apiSearch: z
        .string()
        .optional()
        .describe('Search term typed during interaction (default "a").'),
      extract: z
        .boolean()
        .optional()
        .describe(
          'Capture rendered DOM, computed design tokens, and the real downloaded ' +
            'assets (fonts/images/svg/css) into an assets/ + dom/ layout.',
        ),
      deterministic: z
        .boolean()
        .optional()
        .describe(
          'Deterministic capture (default true): freeze clock, pin UTC/locale, ' +
            'disable animations. Set false to use real time/locale.',
        ),
      mask: z
        .string()
        .optional()
        .describe('Comma-separated CSS selectors to black out in screenshots.'),
      freezeTime: z
        .string()
        .optional()
        .describe('ISO timestamp to freeze the page clock to.'),
      timezone: z.string().optional().describe('IANA timezone (default UTC).'),
      locale: z.string().optional().describe('Locale (default en-US).'),
      prompt: z
        .boolean()
        .optional()
        .describe(
          'Generate REBUILD-PROMPT.md — a self-contained spec referencing every ' +
            'captured artifact so the zip can be handed to an agent to rebuild the ' +
            'site. Default true.',
        ),
      promptStack: z
        .string()
        .optional()
        .describe('Target-stack hint for the rebuild prompt (e.g. "react+tailwind").'),
      full: z
        .boolean()
        .optional()
        .describe(
          'Exhaustively click through the app: recursively record + screenshot every ' +
            'state (modals/tabs/menus/downloads) into explore/. Heavy; off by default.',
        ),
      aggressive: z
        .boolean()
        .optional()
        .describe(
          'With full: click ~everything incl. form submits/mutations (skips only ' +
            'logout/payment). DANGEROUS — only on apps you own/staging.',
        ),
      out: z
        .string()
        .optional()
        .describe('Output directory (default output/<site>).'),
    },
    outputSchema: {
      zipPath: z.string().optional(),
      outDir: z.string(),
      captured: z.number(),
      failed: z.number(),
    },
  },
  async (args) => {
    try {
      const cfg = buildRunConfig({
        url: args.url,
        mode: args.mode ?? 'web',
        pages: args.pages,
        maxPages: args.maxPages,
        depth: args.depth,
        subLinks: args.subLinks,
        maxSubLinksPerPage: args.maxSubLinksPerPage,
        concurrency: args.concurrency,
        zip: args.zip,
        authFile: args.authFile,
        api: args.captureApi,
        apiSameOrigin: args.apiSameOrigin,
        apiInteract: args.interact,
        apiSearch: args.apiSearch,
        extract: args.extract,
        deterministic: args.deterministic,
        mask: args.mask,
        freezeTime: args.freezeTime,
        timezone: args.timezone,
        locale: args.locale,
        prompt: args.prompt,
        promptStack: args.promptStack,
        full: args.full,
        aggressive: args.aggressive,
        out: args.out,
      });

      // Route the pipeline's progress logs to stderr to keep stdout pure.
      const result = await run(cfg, { info: (m) => console.error(m) });

      const structured = {
        zipPath: result.zipPath,
        outDir: result.outDir,
        captured: result.captured,
        failed: result.failed,
      };

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Captured ${result.captured} page(s), ${result.failed} failed.\n` +
              `Zip: ${result.zipPath ?? 'n/a'}\n` +
              `Output dir: ${result.outDir}`,
          },
        ],
        structuredContent: structured,
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `screenshotter failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Do NOT print anything to stdout here — the transport owns stdout.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
