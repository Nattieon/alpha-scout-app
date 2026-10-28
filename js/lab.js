// The lab: the same app built from the experimental branch, served at …/alpha-scout-app/lab/.
// It keeps its own settings and lock marks, and its History shows the experimental formula's replays.
export const LAB = typeof location !== "undefined" && /\/lab\//.test(location.pathname);
