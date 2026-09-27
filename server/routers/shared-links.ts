import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "../db";
import { publicProcedure, router } from "../_core/trpc";

type LocalRequestContext = {
  req: { headers: Record<string, string | string[] | undefined> };
};
type LocalUser = { username: string };
type LocalAccessGuards = {
  requireLocalSession(ctx: LocalRequestContext): LocalUser;
  requireLocalAdmin(ctx: LocalRequestContext): LocalUser;
};

const sharedLinkFields = z.object({
  title: z.string().trim().min(1).max(160),
  url: z.string().trim().url().max(2048).refine(value => /^https?:\/\//i.test(value), "Only HTTP and HTTPS links are allowed."),
  category: z.string().trim().min(1).max(48),
  notes: z.string().trim().max(4000).optional().default(""),
});

async function ensureLinkExists(id: number) {
  const link = await db.getSharedLink(id);
  if (!link) throw new TRPCError({ code: "NOT_FOUND", message: "That shared link no longer exists." });
}

export function createSharedLinksRouter(guards: LocalAccessGuards) {
  return router({
    list: publicProcedure.query(({ ctx }) => {
      guards.requireLocalSession(ctx);
      return db.listSharedLinks();
    }),
    create: publicProcedure.input(sharedLinkFields).mutation(async ({ ctx, input }) => {
      const user = guards.requireLocalAdmin(ctx);
      await db.createSharedLink({ ...input, notes: input.notes || null, createdBy: user.username });
      return { success: true } as const;
    }),
    createMany: publicProcedure.input(z.object({ links: z.array(sharedLinkFields).min(1).max(100) })).mutation(async ({ ctx, input }) => {
      const user = guards.requireLocalAdmin(ctx);
      await db.createSharedLinks(input.links.map(link => ({ ...link, notes: link.notes || null, createdBy: user.username })));
      return { success: true, count: input.links.length } as const;
    }),
    update: publicProcedure.input(sharedLinkFields.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      guards.requireLocalAdmin(ctx);
      await ensureLinkExists(input.id);
      const { id, ...fields } = input;
      await db.updateSharedLink(id, { ...fields, notes: fields.notes || null });
      return { success: true } as const;
    }),
    delete: publicProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      guards.requireLocalAdmin(ctx);
      await ensureLinkExists(input.id);
      await db.deleteSharedLink(input.id);
      return { success: true } as const;
    }),
  });
}
