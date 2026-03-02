/**
 * Who made this and what it is meant to show.
 *
 * The repository link is a placeholder until publication. It renders as muted
 * text rather than as an anchor while it is unfilled, because shipping a demo
 * with a link that 404s is worse than shipping one with no link.
 */

/** Replace with the repository URL at publish time. */
const REPO_URL = 'https://github.com/REPLACE_WITH_REPO/nl-to-app-model';

const REPO_PLACEHOLDER = 'REPLACE_WITH_REPO';

export function About() {
  const repoLinked = !REPO_URL.includes(REPO_PLACEHOLDER);

  return (
    // tabIndex lets fragment navigation move focus here, not only the viewport,
    // so the header link works for someone using a keyboard or a screen reader.
    <footer id="about" className="about" tabIndex={-1} aria-label="About this project">
      <h2>About</h2>
      <p className="about-lede">
        Describe a small app in plain English, and an AI agent builds a working version of it in
        seconds. Use it immediately, or edit its blueprint and watch it update.
      </p>
      <p>
        I built this to work through a pattern I keep running into: getting something structured and
        trustworthy out of a language model, rather than a wall of code you have to read before you
        dare run it. Generation is constrained to a small schema, validated deterministically, and
        the validation errors are fed back to the agent as repair instructions.
      </p>
      <p>
        What it demonstrates is the engineering around that idea rather than the idea itself: a
        bounded tool loop that always returns something renderable, a provider abstraction with two
        real implementations, and an eval that measures whether the agent loop actually beat a
        one-shot baseline. It did not, on validity, and the results say so.
      </p>

      {/* Each on its own line by structure, not by a CSS rule that could change. */}
      <div className="about-meta">
        <p className="about-name">Reza Azad Gholami</p>
        {repoLinked ? (
          <p>
            <a href={REPO_URL} rel="noreferrer">
              Source on GitHub
            </a>
          </p>
        ) : (
          <p className="muted">Repository link to be added at publish time</p>
        )}
      </div>

      <p className="about-note">
        Sample prompts replay recorded generations and cost nothing. Your own prompts run live
        within a small daily budget; when it is spent, the demo falls back to replay until the next
        day.
      </p>
    </footer>
  );
}
