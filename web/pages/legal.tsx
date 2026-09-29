import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Logo } from "../ui/primitives";

const EFFECTIVE = "September 28, 2026";
const CONTACT = "lorencepalisan@gmail.com";

function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-full bg-bg">
      <header className="flex h-16 items-center gap-3 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2 rounded-full pr-3 hover:bg-hover">
          <Logo className="size-9" />
          <span className="text-lg text-fg-2">Family Drive</span>
        </Link>
      </header>
      <main id="content" className="mx-2 mb-4 rounded-2xl bg-surface px-5 py-10 sm:mx-4 sm:px-10">
        <article className="mx-auto max-w-[68ch] text-[15px] leading-7 text-fg-2 [&_a]:text-primary [&_a]:underline [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-medium [&_h2]:text-fg [&_li]:mb-1.5 [&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5">
          <Link to="/" className="mb-6 inline-flex items-center gap-2 text-sm !no-underline">
            <ArrowLeft size={16} /> Back to Family Drive
          </Link>
          <h1 className="mb-2 text-[32px] leading-tight font-normal text-fg">{title}</h1>
          <p className="text-sm text-fg-3">Effective {EFFECTIVE}</p>
          {children}
          <hr className="my-10 border-line" />
          <p className="text-sm">
            See also: <Link to="/terms">Terms of Service</Link> · <Link to="/privacy">Privacy Policy</Link>
          </p>
        </article>
      </main>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy">
      <p>
        Family Drive (drive.lorencepalisan.com) is a private, invite-only file storage site run by Lorence Palisan for
        family members. This policy explains what information the site handles, why, and what you can do about it. It
        is written for family use, not for a commercial service.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <b>Your Google account basics:</b> your name, email address and profile photo, received when you sign in
          with Google. Your email is also how invites work.
        </li>
        <li>
          <b>Files you upload</b>, stored exactly as uploaded, plus details about them: name, size, type, folder, image
          or video dimensions, and small preview thumbnails made in your browser.
        </li>
        <li>
          <b>Activity inside the app:</b> what you shared and with whom, starred items, recently opened files,
          notifications, your light or dark theme choice, and invite records.
        </li>
        <li>
          <b>A sign-in cookie</b> that keeps you logged in for up to 30 days. There are no advertising or tracking
          cookies. The site remembers your list or grid view and theme in your own browser.
        </li>
        <li>
          <b>Basic server logs</b> (for example errors and request times) kept by our hosting provider for running
          and fixing the site.
        </li>
      </ul>

      <h2>Google Drive access ("Open with")</h2>
      <p>
        If you choose <b>Open with Google Docs, Sheets or Slides</b>, the site asks for permission to create files in
        your Google Drive (the <code>drive.file</code> scope). It can only see and change files it created for you, not
        the rest of your Google Drive. It uses this only to put a copy of the file you chose into your Google Drive and,
        if you ask, to bring your edited version back. You can disconnect this at any time from your profile menu, or
        in your Google Account's security settings.
      </p>
      <h2>Google Drive sync</h2>
      <p>
        If you turn on <b>Google Drive sync</b>, the site also asks for read-only access to your Google Drive (the{" "}
        <code>drive.readonly</code> scope). It uses this only to list the folders you can choose from and to copy the
        folders you picked (and later changes to them) into your own Family Drive storage. It never changes or deletes
        anything in your Google Drive. To notice changes, it checks the list of recently changed files in your Google
        Drive; changes outside the folders you chose are ignored and not stored. Stop syncing a
        folder from the Google Drive sync page, or disconnect Google Drive from your profile menu at any time. Files
        already copied stay in Family Drive until you delete them.
      </p>
      <p>
        Family Drive's use and transfer of information received from Google APIs will adhere to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2>How your information is used</h2>
      <ul>
        <li>To let you sign in, store, preview, organise, share and download your files.</li>
        <li>To send invite emails and "shared with you" emails, and to show in-app notifications.</li>
        <li>To enforce storage limits and keep the site secure and working.</li>
      </ul>
      <p>
        We do not sell your information, show ads, or use your files for anything other than running Family Drive.
        In the app, the site owner sees account-level details (names, emails and how much storage each person uses),
        not the contents of files that weren't shared with them. Because the owner runs the servers, they could
        technically reach stored data; they will only do so to fix a problem you ask about, or when required by law.
      </p>

      <h2>Who else handles it</h2>
      <ul>
        <li>
          <b>Cloudflare</b> hosts the site and stores files and the database, in its Asia-Pacific region.
        </li>
        <li>
          <b>Google</b> provides sign-in, and Google Drive if you use "Open with".
        </li>
        <li>
          <b>Resend</b> delivers invite and sharing emails.
        </li>
      </ul>
      <p>These providers process data on our behalf under their own terms and security practices.</p>

      <h2>Sharing</h2>
      <p>
        Your files are private to you unless you share them. Sharing a folder gives the people you pick access to
        everything inside it. If you turn on <b>"Anyone with the link"</b>, anyone who has that link can view and
        download the item without signing in, until you turn it off or the link expires.
      </p>

      <h2>How long we keep things</h2>
      <ul>
        <li>Files stay until you delete them. Items in Trash are permanently deleted after 30 days.</li>
        <li>Sign-in sessions end after 30 days. Notifications are removed after 90 days.</li>
        <li>If you ask for your account to be removed, we delete your account and the files you own.</li>
      </ul>

      <h2>Your choices and rights</h2>
      <p>
        You can download, rename, move or delete your files at any time. You can also ask us to tell you what
        information we hold about you, correct it, or delete your account, by emailing{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. We respect your rights under the Philippine Data Privacy Act of 2012
        and other laws that apply to you.
      </p>

      <h2>Security</h2>
      <p>
        Connections use HTTPS, sign-in uses Google, Google Drive access tokens are stored encrypted, and uploaded web
        pages are never run inside the site. No system is perfectly secure, so please don't store anything you couldn't
        afford to have exposed, and tell us right away if you notice something wrong.
      </p>

      <h2>Children</h2>
      <p>Younger family members should use Family Drive with a parent or guardian's permission and supervision.</p>

      <h2>Changes</h2>
      <p>If this policy changes, we'll update the date above and let family members know about important changes.</p>

      <h2>Contact</h2>
      <p>
        Questions or requests: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </p>
    </LegalLayout>
  );
}

export function TermsPage() {
  return (
    <LegalLayout title="Terms of Service">
      <p>
        These terms cover your use of Family Drive (drive.lorencepalisan.com), a private file storage site run by
        Lorence Palisan for invited family members. By signing in, you agree to them.
      </p>

      <h2>Who can use it</h2>
      <p>
        Family Drive is invite-only. You need an invite and a Google account with the invited email address. Keep your
        Google account secure: anyone who can sign in to it can use your Family Drive account. The owner can remove
        access or revoke invites at any time.
      </p>

      <h2>Your files</h2>
      <p>
        You keep ownership of everything you upload. You give Family Drive permission to store, copy, process (for
        example to make previews and thumbnails) and show your files only as needed to run the service for you and the
        people you share with. You're responsible for what you upload and share, and for having the right to do so.
      </p>

      <h2>What's not allowed</h2>
      <ul>
        <li>Uploading anything illegal, or content you don't have the rights to share.</li>
        <li>Malware, or files meant to harm people or computers.</li>
        <li>Using Family Drive to harass anyone or to share other people's private information without permission.</li>
        <li>Trying to access other people's files or accounts, or to overload, probe or break the site.</li>
        <li>Using it to run a business or public file-hosting service.</li>
      </ul>
      <p>We may remove content or suspend access that breaks these rules.</p>

      <h2>Sharing and public links</h2>
      <p>
        When you share with a family member, they can view or edit based on the access you choose, including everything
        inside a shared folder. Links set to "Anyone with the link" can be opened by anyone who gets the link, so share
        them carefully and turn them off when they're no longer needed.
      </p>

      <h2>Storage</h2>
      <p>
        Each person has a storage limit shown in the sidebar. Items in Trash count toward it until they're deleted,
        and are deleted automatically after 30 days.
      </p>

      <h2>Google services</h2>
      <p>
        Signing in and "Open with Google Docs, Sheets or Slides" use Google. Your use of Google's products is also
        covered by Google's own terms. Files copied into your Google Drive are managed there and aren't deleted when you
        delete them in Family Drive.
      </p>

      <h2>No guarantees</h2>
      <p>
        Family Drive is provided free, as is, by a family member, without any warranty. We work to keep it available and
        your files safe, but outages or data loss can happen. Keep your own copy of anything important. To the extent
        the law allows, the owner isn't liable for lost data, downtime, or indirect damages from using the site.
      </p>

      <h2>Ending your use</h2>
      <p>
        You can stop using Family Drive at any time and ask for your account and files to be deleted. Download anything
        you want to keep first. If the site is ever shut down, family members will be given reasonable notice to
        download their files.
      </p>

      <h2>Changes</h2>
      <p>These terms may be updated. The date above shows the latest version; continuing to use the site means you accept it.</p>

      <h2>Contact</h2>
      <p>
        Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </p>
    </LegalLayout>
  );
}

/** Small "Privacy · Terms" links for footers. */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={className}>
      <Link to="/privacy" className="hover:underline">
        Privacy
      </Link>
      <span aria-hidden> · </span>
      <Link to="/terms" className="hover:underline">
        Terms
      </Link>
    </nav>
  );
}
