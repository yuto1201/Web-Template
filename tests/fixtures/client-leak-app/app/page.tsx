import DeliberateClientLeak from "./static-leak";

export default function DeliberatelyLeakyFixturePage() {
  return (
    <main data-deliberate-leak={process.env.SUPABASE_SERVICE_ROLE_KEY}>
      Positive control
      <DeliberateClientLeak />
    </main>
  );
}
