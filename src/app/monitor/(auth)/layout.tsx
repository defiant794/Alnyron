import MonitorAuthFrame from "@/components/monitor/MonitorAuthFrame";

/** Login, signup, forgot password and reset: the centered Monitor card. */
export default function MonitorAuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <MonitorAuthFrame>{children}</MonitorAuthFrame>;
}
