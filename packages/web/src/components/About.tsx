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
    <footer className="about" aria-label="About this project">
      <h2>About</h2>
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
      <p className="about-meta">
        <span>Reza Azad Gholami</span>
        {repoLinked ? (
          <a href={REPO_URL} rel="noreferrer">
            Source on GitHub
          </a>
        ) : (
          <span className="muted">Repository link to be added at publish time</span>
        )}
      </p>
      <p className="about-note">
        This public demo replays generations recorded earlier. It makes no live model calls.
      </p>
    </footer>
  );
}
