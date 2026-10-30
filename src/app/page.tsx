// F0.1 placeholder. The real design-01 home page is built in F1.2.
// #main is the SkipLink target; tabIndex -1 lets the skip link move focus here.
export default function Home() {
  return (
    <main id="main" tabIndex={-1} className="focus:outline-none">
      <h1>Alnyron</h1>
    </main>
  );
}
