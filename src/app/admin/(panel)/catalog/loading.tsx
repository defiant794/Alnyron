import { NavigationPendingFallback } from "@/components/admin/NavigationPending";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { loadMessages } from "@/i18n/messages";

/**
 * Loading state of every catalog admin page ("Indlæser siden …"). Next.js
 * keys this boundary by the catalog child segment (overview, a kind
 * shortcut, a section editor, an item editor), so moving between them mounts
 * a fresh boundary: when the navigation's prefetch has already arrived, the
 * fallback replaces the outgoing page while the rest of the next one loads.
 * The admin shell's status region announces it (`NavigationPendingFallback`);
 * before any server response the shell's `NavigationPending` shows the same
 * status.
 */
export default function CatalogLoading() {
  return <NavigationPendingFallback label={loadMessages(AUTH_LOCALE).Admin.loading} />;
}
