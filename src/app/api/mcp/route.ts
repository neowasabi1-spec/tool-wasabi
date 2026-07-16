import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { mcpContext, currentOwnerId } from '@/lib/mcp/context';
import { resolveOwner, unauthorizedResponse } from '@/lib/mcp/auth';
import {
  cloneLandingPage,
  extractTexts,
  applyRewrites,
} from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
  };
}

const mcpHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      'clone_landing_page',
      {
        title: 'Clone landing page',
        description:
          'Clone a landing page from its URL into an editable snapshot. Returns an assetId used by the other tools. Use this first. Dynamic content (fake live chat, counters, countdowns) is preserved automatically in "auto" mode.',
        inputSchema: {
          url: z.string().url().describe('The public URL of the page to clone.'),
          scripts_mode: z
            .enum(['auto', 'keep', 'strip'])
            .optional()
            .describe('How to handle the page scripts. Default "auto".'),
        },
      },
      async ({ url, scripts_mode }) => {
        try {
          const r = await cloneLandingPage(currentOwnerId(), url, scripts_mode ?? 'auto');
          return ok(r);
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      'extract_texts',
      {
        title: 'Extract rewritable texts',
        description:
          'Extract the rewritable copy from a previously cloned asset. Returns a list of { id, text, tag }. YOU (Claude) then rewrite each text for the target product and send them back via apply_rewrites. Preserve the copy type per tag: headline = punchy, body = explanatory, CTA = short imperative, bullet = scannable.',
        inputSchema: {
          assetId: z.string().describe('The assetId returned by clone_landing_page.'),
        },
      },
      async ({ assetId }) => {
        try {
          const r = await extractTexts(currentOwnerId(), assetId);
          return ok(r);
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      'apply_rewrites',
      {
        title: 'Apply rewrites',
        description:
          'Apply your rewritten texts to the cloned asset and produce the final page. Pass the same ids returned by extract_texts, each with your rewritten string. Returns a previewUrl (open in a browser) and a downloadUrl for the final HTML.',
        inputSchema: {
          assetId: z.string().describe('The assetId returned by clone_landing_page.'),
          rewrites: z
            .array(
              z.object({
                id: z.number().describe('The text id from extract_texts.'),
                rewritten: z.string().describe('Your rewritten copy for that id.'),
              }),
            )
            .describe('One entry per text id you want to replace.'),
        },
      },
      async ({ assetId, rewrites }) => {
        try {
          const r = await applyRewrites(currentOwnerId(), assetId, rewrites);
          return ok(r);
        } catch (e) {
          return fail(e);
        }
      },
    );
  },
  {},
  { basePath: '/api', maxDuration: 60 },
);

async function handle(req: Request): Promise<Response> {
  const auth = resolveOwner(req);
  if (!auth) return unauthorizedResponse();
  return mcpContext.run({ ownerId: auth.ownerId }, () => mcpHandler(req));
}

export { handle as GET, handle as POST, handle as DELETE };
