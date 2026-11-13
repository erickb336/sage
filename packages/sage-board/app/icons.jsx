const Svg = ({ children, className = "ico" }) => <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">{children}</svg>;

export const OverviewIcon = () => <Svg><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></Svg>;
export const TasksIcon = () => <Svg><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M5 8l2 2 4-4" /></Svg>;
export const AgentsIcon = () => <Svg><circle cx="8" cy="4" r="2" /><circle cx="3.5" cy="12" r="2" /><circle cx="12.5" cy="12" r="2" /><path d="M8 6v2M8 8l-3.5 2.5M8 8l3.5 2.5" /></Svg>;
export const PullsIcon = () => <Svg><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="12.5" r="1.5" /><path d="M4 5v6M12 11V6.5A2 2 0 0010 4.5H7.5M9 3l-1.5 1.5L9 6" /></Svg>;
export const LeafIcon = () => <Svg><path d="M3 13c0-6 4-10 10-10 0 6-4 10-10 10zM3 13l6-6" /></Svg>;
export const MoonIcon = () => <Svg><path d="M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z" /></Svg>;
export const SunIcon = () => <Svg><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></Svg>;
export const AlertIcon = () => <Svg><path d="M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.01" /></Svg>;

export function StateIcon({ state }) {
  const filled = state === "done";
  return <svg className={`state ${state}`} viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path d="M7 1l6 6-6 6-6-6z" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" /></svg>;
}
