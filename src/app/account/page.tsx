import { redirect } from "next/navigation";
import { getVerifiedSubject } from "@/lib/auth/claims";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { addOwnerItemAction, logoutAction } from "./actions";

export const dynamic = "force-dynamic";

const accountMessages: Record<string, string> = {
  invalid_label: "Enter between one and 120 characters.",
  item_added: "The owner-scoped row was added.",
  write_failed: "The row could not be written.",
};

type AccountPageProperties = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AccountPage({ searchParams }: AccountPageProperties) {
  const client = await createSupabaseServerClient();
  const subject = await getVerifiedSubject(client);
  if (!subject) {
    redirect("/login?next=%2Faccount");
  }

  const { data: items, error } = await client
    .from("owner_items")
    .select("id,label,created_at")
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error("The protected owner rows could not be loaded.");
  }

  const parameters = await searchParams;
  const messageKey = first(parameters.error) ?? first(parameters.notice);
  const message = messageKey ? accountMessages[messageKey] : null;

  return (
    <main className="account-shell">
      <header className="account-header">
        <div>
          <p className="eyebrow">Protected / dynamic / no-store</p>
          <h1>Your RLS workspace.</h1>
        </div>
        <form action={logoutAction}><button className="secondary-action" type="submit">Sign out</button></form>
      </header>

      <section className="account-grid">
        <div className="account-card account-identity">
          <p className="section-label">Verified subject</p>
          <code>{subject}</code>
          <p>Authorization came from signed JWT claims. User metadata is never consulted.</p>
        </div>

        <div className="account-card">
          <p className="section-label">Create an owned row</p>
          {message ? <p className="form-message" role="status">{message}</p> : null}
          <form action={addOwnerItemAction} className="item-form">
            <label htmlFor="item-label">Label</label>
            <div>
              <input id="item-label" name="label" required minLength={1} maxLength={120} />
              <button className="primary-action" type="submit">Add row</button>
            </div>
          </form>
        </div>
      </section>

      <section className="owner-items" aria-labelledby="owner-items-title">
        <div>
          <p className="section-label">Visible through RLS</p>
          <h2 id="owner-items-title">Owner items</h2>
        </div>
        {items.length > 0 ? (
          <ol>{items.map((item) => <li key={item.id}><span>{item.label}</span><time>{new Date(item.created_at).toISOString()}</time></li>)}</ol>
        ) : <p className="empty-state">No rows are visible for this verified subject yet.</p>}
      </section>
    </main>
  );
}
