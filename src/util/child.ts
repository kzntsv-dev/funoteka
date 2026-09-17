/**
 * What every child process this project starts is told.
 *
 * `windowsHide` is the one that matters, and it is the one that is easy to
 * forget. The server runs as a daemon with no console of its own, and Windows
 * gives every console program started from a console-less process a *new*
 * window — so a song that has to be re-encoded flashes a black rectangle on the
 * operator's screen, one per transcode, one per probe of a file whose codec
 * nobody has established, and one per library scan. It is not an error and not
 * a symptom: it is what the operating system does by default, and the default
 * is wrong here.
 *
 * There is no test that can assert a window did not appear. This file is the
 * next best thing: one place that says why, so that the next `spawn` has
 * somewhere to look and something to copy.
 *
 * The rest of the options stay at each call site, because how a child's streams
 * are wired is that call's own business — a probe wants its output read, a
 * transcode wants it written to a file, and neither is a rule.
 */
export const HIDDEN = { windowsHide: true } as const;
