export type PageHeaderProps = {
  title: string;
  description?: string;
};

/** Title row of an admin panel page (approved admin mock: h1 with a muted line under it). */
export default function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-h1 font-semibold">{title}</h1>
      {description && <p className="max-w-prose text-muted">{description}</p>}
    </header>
  );
}
