import { redirect } from "next/navigation";

export default function OrgRoot({ params }: { params: { orgSlug: string } }) {
  // The org root is the exposure board. It is the product's home surface: the
  // one question a seller signs in to answer is which states they have crossed.
  redirect(`/orgs/${params.orgSlug}/exposure`);
}
