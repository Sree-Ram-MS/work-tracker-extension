// Determines which icon state the toolbar icon should show, based on today's entries.
//
// Task statuses:  todo | inprogress | completed
// Icon states:    freeze | advance(todo) | progress(inprogress) | hot(completed)
//   (icon asset files keep their original names, only their meaning changed)
//
// Priority (most attention-grabbing first):
//   inprogress -> at least one entry is "In Progress"   -> progress icon (something else in mind)
//   todo       -> no in-progress, but some "To Do" left -> advance icon  (still pending)
//   completed  -> everything logged today is completed  -> hot icon
//   freeze     -> no entries at all for today            -> freeze icon

export const STATUS = {
  TODO: "todo",
  INPROGRESS: "inprogress",
  COMPLETED: "completed"
};

export const STATUS_META = {
  todo: { label: "To Do", icon: "advance", color: "#7c4dd2", hint: "Queued — not started yet" },
  inprogress: { label: "In Progress", icon: "progress", color: "#f0a528", hint: "Something else in mind" },
  completed: { label: "Completed", icon: "hot", color: "#d62a2a", hint: "Hot — done for today" }
};

export function computeDayIconState(entriesForToday) {
  if (!entriesForToday || entriesForToday.length === 0) return "freeze";
  if (entriesForToday.some((e) => e.status === STATUS.INPROGRESS)) return "progress";
  if (entriesForToday.some((e) => e.status === STATUS.TODO)) return "advance";
  return "hot"; // everything left is completed
}

// Build icon paths. Pass chrome.runtime.getURL when calling from a context
// that has it (background service worker) for a fully-qualified URL, which
// is more reliable for chrome.action.setIcon than a bare relative path.
export function iconPaths(state, getURL) {
  const sizes = [16, 32, 48, 128];
  const out = {};
  sizes.forEach((s) => {
    const rel = `icons/${state}-${s}.png`;
    out[s] = getURL ? getURL(rel) : rel;
  });
  return out;
}
