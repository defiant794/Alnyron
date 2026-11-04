import { notFound, redirect } from "next/navigation";
import { adminCategoryPath } from "@/config/admin";
import { CATALOG_KINDS } from "@/config/catalog";
import { getCategoryIdForKind } from "@/services/admin/catalog-read";
import { requireAdmin } from "@/services/auth/require-admin";

type CatalogKindPageProps = Readonly<{ params: Promise<{ kind: string }> }>;

/**
 * `/admin/catalog/<kind>` (`apps`, `websites`, `services`, `models3d`): the
 * sidebar's kind shortcut. Sections are edited by id, so this resolves the
 * kind's section and redirects to its editor; an unknown kind, or a kind
 * without a section, is a 404.
 */
export default async function CatalogKindPage({ params }: CatalogKindPageProps) {
  await requireAdmin();
  const { kind } = await params;
  const catalogKind = CATALOG_KINDS.find((candidate) => candidate === kind);
  if (!catalogKind) notFound();

  const categoryId = await getCategoryIdForKind(catalogKind);
  if (!categoryId) notFound();
  redirect(adminCategoryPath(categoryId));
}
