import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/useDocumentTitle';
import './LegalPage.css';

/** Effective date shown at the top of the policy. Bump this in the same commit
 * as any material change to the text below (mirrors the docs/ legal pages). */
const LAST_UPDATED = 'June 28, 2026';

/** Self-contained legal/DMCA page. Lives in-app (unlike the standalone
 * docs/ Privacy + Terms pages, which Vercel's catch-all rewrite does not serve
 * from readmo.app), so it must not depend on those files. No auth gate —
 * informational only, no user data. */
export function LegalPage() {
  usePageTitle('Legal');

  return (
    <article className="legal-page">
      <h1 className="legal-page__title">Legal</h1>
      <p className="legal-page__effective">Last updated: {LAST_UPDATED}</p>

      <p>
        Readmo is a reader for the RSS, Atom, and JSON feeds you subscribe to,
        operated by{' '}
        <a
          href="https://mikelward.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          Mikel Ward
        </a>
        . These terms govern your use of Readmo. By using the service you agree
        to them; if you do not agree, please do not use it.
      </p>

      <h2 className="legal-page__heading">Third-party content</h2>
      <p>
        The articles and feeds shown in Readmo are created and owned by their
        respective publishers. Readmo fetches the syndicated content those
        publishers themselves make available and always links back to the
        original source. Readmo is independent and not affiliated with any
        publisher, and inclusion of a feed is not an endorsement. Your use of
        third-party content may also be subject to the publisher&rsquo;s own
        terms.
      </p>

      <h2 className="legal-page__heading">Copyright and DMCA</h2>
      <p>
        Readmo respects the intellectual property of others and responds to
        clear notices of alleged copyright infringement under the U.S. Digital
        Millennium Copyright Act (DMCA). If you are a copyright owner, or
        authorized to act for one, and believe material surfaced by Readmo
        infringes your copyright, send a written notice to{' '}
        <a href="mailto:mikel@mikelward.com">mikel@mikelward.com</a> that
        includes:
      </p>
      <ul className="legal-page__list">
        <li>
          A physical or electronic signature of the copyright owner or a person
          authorized to act on their behalf.
        </li>
        <li>
          Identification of the copyrighted work you claim has been infringed.
        </li>
        <li>
          Identification of the material you claim is infringing, with enough
          detail (such as the article URL within Readmo) for us to locate it.
        </li>
        <li>Your name, address, telephone number, and email address.</li>
        <li>
          A statement that you have a good-faith belief that the use is not
          authorized by the copyright owner, its agent, or the law.
        </li>
        <li>
          A statement, made under penalty of perjury, that the information in
          your notice is accurate and that you are the owner or authorized to
          act on the owner&rsquo;s behalf.
        </li>
      </ul>
      <p>
        On receiving a valid notice we will remove or disable access to the
        material within Readmo and, where appropriate, terminate the access of
        users who are repeat infringers. Because Readmo displays content fetched
        from a publisher&rsquo;s own feed and links back to it, removing
        material from Readmo does not remove it from its original source &mdash;
        notices about content you do not control should go to the publisher that
        hosts it.
      </p>

      <h2 className="legal-page__heading">Counter-notification</h2>
      <p>
        If you believe material was removed or disabled by mistake or
        misidentification, you may send a counter-notification to{' '}
        <a href="mailto:mikel@mikelward.com">mikel@mikelward.com</a> that
        includes:
      </p>
      <ul className="legal-page__list">
        <li>Your physical or electronic signature.</li>
        <li>
          Identification of the material that was removed or disabled and the
          location where it appeared before it was removed.
        </li>
        <li>
          A statement, made under penalty of perjury, that you have a good-faith
          belief the material was removed or disabled as a result of mistake or
          misidentification.
        </li>
        <li>
          Your name, address, and telephone number, and a statement that you
          consent to the jurisdiction of the U.S. federal district court for the
          judicial district where your address is located &mdash; or, if your
          address is outside the United States, any judicial district in which
          the operator may be found &mdash; and that you will accept service of
          process from the person who filed the original notice or their agent.
        </li>
      </ul>

      <h2 className="legal-page__heading">Acceptable use</h2>
      <p>You agree not to:</p>
      <ul className="legal-page__list">
        <li>Use Readmo to break the law or infringe the rights of others.</li>
        <li>
          Disrupt, overload, reverse-engineer, or gain unauthorized access to
          the service or its infrastructure.
        </li>
        <li>
          Access or distribute content you are not permitted to access or
          distribute.
        </li>
      </ul>

      <h2 className="legal-page__heading">Disclaimer of warranties</h2>
      <p>
        Readmo is provided on a best-effort basis, &ldquo;as is&rdquo; and
        &ldquo;as available,&rdquo; without warranties of any kind, whether
        express or implied, including fitness for a particular purpose and
        non-infringement, to the fullest extent permitted by law. We do not
        guarantee that feeds will always be fetched, complete, or up to date.
      </p>

      <h2 className="legal-page__heading">Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, the operator will not be liable
        for any indirect, incidental, or consequential damages, or for any loss
        of data, arising from your use of (or inability to use) Readmo.
      </p>

      <h2 className="legal-page__heading">Privacy</h2>
      <p>
        Readmo stores your account, subscriptions, and reading state so they can
        sync across your devices, and caches recent content on your device for
        offline reading. Your reading data is isolated per user &mdash; other
        signed-in users cannot see your subscriptions, folders, or item state.
        Readmo does not sell your personal information and does not use it for
        advertising. You can request deletion of your account and associated
        data at any time by emailing{' '}
        <a href="mailto:mikel@mikelward.com">mikel@mikelward.com</a>.
      </p>

      <h2 className="legal-page__heading">Changes</h2>
      <p>
        We may update these terms from time to time. Material changes are
        reflected by updating the date at the top of this page; continued use
        after a change means you accept the updated terms.
      </p>

      <h2 className="legal-page__heading">Contact</h2>
      <p>
        Questions about anything on this page? Email{' '}
        <a href="mailto:mikel@mikelward.com">mikel@mikelward.com</a>.
      </p>

      <p className="legal-page__back">
        <Link to="/">&larr; Back to Home</Link>
      </p>
    </article>
  );
}
