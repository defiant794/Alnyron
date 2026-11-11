import Badge from "@/components/ui/Badge";
import Link from "@/components/ui/Link";
import { displayUrl } from "@/lib/monitor/format";
import type { MonitorSite } from "@/services/admin/monitor-users";

/** Copy of the sites list (keys as in `MonitorSignupsTable`'s labels). */
export type MonitorSiteLinksLabels = {
  /** Shown for a signup without monitors. */
  sitesNone: string;
  /** Marks a paused monitor. */
  sitesPaused: string;
  /** Ends each link's accessible name: the link opens the site in a new tab. */
  newTab: string;
};

export type MonitorSiteLinksProps = {
  /** The signup's monitors, oldest first. */
  sites: readonly MonitorSite[];
  labels: MonitorSiteLinksLabels;
};

/**
 * The sites a Monitor signup watches (Admin › Monitor-brugere, Overvåger):
 * each one a link to the site in a new tab, named by its label or else its
 * address without the scheme (`displayUrl`), a paused one marked next to it;
 * muted "Ingen" without monitors. A long name is cut off with an ellipsis, the
 * link still leads to the whole URL. The URLs are http(s) only (the monitors'
 * `monitors_url_valid` check).
 */
export default function MonitorSiteLinks({ sites, labels }: MonitorSiteLinksProps) {
  if (sites.length === 0) return <span className="text-muted">{labels.sitesNone}</span>;

  return (
    <ul className="flex max-w-40 flex-col gap-1">
      {sites.map((site, index) => (
        // Sites have no id of their own; the list keeps the RPC's order and is never reordered here.
        <li key={index} className="flex flex-wrap items-center gap-x-2">
          <Link href={site.url} target="_blank" className="inline-flex min-h-11 max-w-full items-center text-small">
            <span className="truncate">{site.label || displayUrl(site.url)}</span>
            <span className="sr-only"> ({labels.newTab})</span>
          </Link>
          {site.status === "paused" && <Badge>{labels.sitesPaused}</Badge>}
        </li>
      ))}
    </ul>
  );
}
