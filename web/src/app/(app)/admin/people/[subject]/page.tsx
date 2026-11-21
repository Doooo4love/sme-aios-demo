import { EmployeeAccessDetailView } from "@/features/people/EmployeeAccessDetailView";

interface PageProps {
  params: Promise<{ subject: string }>;
}

export default async function AdminPersonDetailPage({ params }: PageProps) {
  const { subject: rawSubject } = await params;
  let subject = rawSubject;
  try {
    subject = decodeURIComponent(rawSubject);
  } catch {
    subject = rawSubject;
  }
  return <EmployeeAccessDetailView subject={subject} />;
}
