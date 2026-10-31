import AuthFrame from "@/components/admin/AuthFrame";

/** Login and forgot password: served without a session, in the centered card frame. */
export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AuthFrame>{children}</AuthFrame>;
}
