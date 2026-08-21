"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getVerifiedSubject } from "@/lib/auth/claims";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function addOwnerItemAction(formData: FormData) {
  const client = await createSupabaseServerClient();
  const subject = await getVerifiedSubject(client);
  if (!subject) {
    redirect("/login?next=%2Faccount");
  }

  const rawLabel = formData.get("label");
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (label.length < 1 || label.length > 120) {
    redirect("/account?error=invalid_label");
  }

  const { error } = await client.from("owner_items").insert({ label });
  if (error) {
    redirect("/account?error=write_failed");
  }
  revalidatePath("/account");
  redirect("/account?notice=item_added");
}

export async function logoutAction() {
  const client = await createSupabaseServerClient();
  await client.auth.signOut();
  redirect("/login?notice=signed_out");
}
