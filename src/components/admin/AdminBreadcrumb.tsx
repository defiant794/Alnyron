import { Fragment } from "react";
import Link from "@/components/ui/Link";

export type AdminBreadcrumbItem = {
  label: string;
  /** Omitted on the current page (the last item). */
  href?: string;
};

export type AdminBreadcrumbProps = {
  /** Accessible name of the navigation ("Brødkrummesti"). */
  label: string;
  items: AdminBreadcrumbItem[];
};

/**
 * Trail above an admin editor (approved mocks: "Katalog / Apps / Alnyron
 * Puls"). Links lead back up; the current page is plain text marked
 * `aria-current="page"`; the slashes are decorative.
 */
export default function AdminBreadcrumb({ label, items }: AdminBreadcrumbProps) {
  return (
    <nav aria-label={label}>
      <ol className="flex flex-wrap items-center gap-x-2 text-small text-muted">
        {items.map((item, index) => (
          <Fragment key={`${index}-${item.label}`}>
            {index > 0 && (
              <li aria-hidden="true" className="select-none">
                /
              </li>
            )}
            <li>
              {item.href ? (
                <Link href={item.href} className="inline-flex min-h-11 items-center">
                  {item.label}
                </Link>
              ) : (
                <span aria-current="page">{item.label}</span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
