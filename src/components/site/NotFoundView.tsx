import LinkButton from "@/components/ui/LinkButton";

export type NotFoundViewProps = {
  title: string;
  body: string;
  homeLabel: string;
  /** Home URL in the page's locale (`/` or `/en`). */
  homeHref: string;
};

/** 404 content shared by the localized and the root not-found pages. */
export default function NotFoundView({ title, body, homeLabel, homeHref }: NotFoundViewProps) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex max-w-content flex-col items-start gap-6 px-6 py-24 focus:outline-none"
    >
      <h1 className="text-h1 font-bold">{title}</h1>
      <p className="text-muted">{body}</p>
      <LinkButton href={homeHref}>{homeLabel}</LinkButton>
    </main>
  );
}
