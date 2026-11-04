import Badge, { type BadgeTone } from "@/components/ui/Badge";
import Link from "@/components/ui/Link";
import { catalogVisibilityBadge, type CatalogVisibility } from "@/lib/catalog-visibility-badge";
import type { Database } from "@/types/database";

type ContentStatus = Database["public"]["Enums"]["content_status"];

/** One section of the catalog overview, already labelled by the server. */
export type CatalogOverviewRow = {
  id: string;
  /** The section's Danish title. */
  title: string;
  /** Its public path (`/apps`), shown under the title when it has one. */
  path?: string;
  status: ContentStatus;
  publishedCount: number;
  draftCount: number;
  editHref: string;
};

export type CatalogOverviewTableProps = {
  rows: CatalogOverviewRow[];
  /** Id of the heading that names the table. */
  labelledBy?: string;
  labels: {
    edit: string;
    visibility: { synlig: string; visesVedForste: string; skjult: string };
    counts: { published: (count: number) => string; draft: (count: number) => string };
    /** Column headings (Sektion / Synlighed / Elementer / Handling). */
    columns?: { section: string; visibility: string; items: string; actions: string };
  };
};

const BADGE_TONES: Record<CatalogVisibility, BadgeTone> = {
  synlig: "success",
  "vises-ved-forste": "neutral",
  skjult: "error",
};

/**
 * The catalog sections at a glance (approved overview mock): title and public
 * path, the visibility badge ({@link catalogVisibilityBadge}: Synlig in green,
 * "Vises ved første udgivne element" neutral, Skjult in red; the words carry
 * the meaning), published and draft counts, and "Rediger" to the section
 * editor (described by the section title). Narrow screens scroll the table
 * sideways. A server component: the count labels are functions.
 */
export default function CatalogOverviewTable({ rows, labelledBy, labels }: CatalogOverviewTableProps) {
  const visibilityText: Record<CatalogVisibility, string> = {
    synlig: labels.visibility.synlig,
    "vises-ved-forste": labels.visibility.visesVedForste,
    skjult: labels.visibility.skjult,
  };

  return (
    <div className="overflow-x-auto">
      <table aria-labelledby={labelledBy} className="w-full min-w-xl text-left">
        {labels.columns && (
          <thead>
            <tr className="border-b border-border text-xs tracking-widest text-muted uppercase">
              <th scope="col" className="px-6 py-3 font-semibold">
                {labels.columns.section}
              </th>
              <th scope="col" className="px-6 py-3 font-semibold">
                {labels.columns.visibility}
              </th>
              <th scope="col" className="px-6 py-3 font-semibold">
                {labels.columns.items}
              </th>
              <th scope="col" className="px-6 py-3 text-right font-semibold">
                {labels.columns.actions}
              </th>
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row) => {
            const visibility = catalogVisibilityBadge(row.status, row.publishedCount);
            const titleId = `catalog-section-${row.id}`;
            return (
              <tr key={row.id} className="border-b border-border align-middle last:border-b-0">
                <th scope="row" className="px-6 py-4 text-left font-normal">
                  <span className="flex flex-col gap-1">
                    <span id={titleId} className="font-semibold">
                      {row.title}
                    </span>
                    {row.path && <span className="text-small text-muted">{row.path}</span>}
                  </span>
                </th>
                <td className="px-6 py-4">
                  <Badge tone={BADGE_TONES[visibility]}>{visibilityText[visibility]}</Badge>
                </td>
                <td className="px-6 py-4 text-small whitespace-nowrap text-muted">
                  <span>{labels.counts.published(row.publishedCount)}</span>
                  <span aria-hidden="true"> · </span>
                  <span className="sr-only">, </span>
                  <span>{labels.counts.draft(row.draftCount)}</span>
                </td>
                <td className="px-6 py-4 text-right">
                  <Link
                    href={row.editHref}
                    aria-describedby={titleId}
                    className="inline-flex min-h-11 items-center px-2 font-semibold"
                  >
                    {labels.edit}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
