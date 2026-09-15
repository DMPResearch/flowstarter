import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useUser,
  useClerk,
  useAuth,
} from "@clerk/clerk-react";
import { ThemeToggle } from "@flowstarter/flow-design-system";
import { buildFlowstarterClerkUserButtonAppearance } from "@flowstarter/flow-design-system/clerk";
import { LogInIcon, LogOutIcon, UserIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { useTheme } from "../hooks/useTheme";
import { useTier } from "../hooks/useTier";
import { editorOriginUrl, withBasePath } from "../lib/basePath";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";

/**
 * Editor `UserButton` / `SignInButton` use `@flowstarter/flow-design-system/clerk`
 * (`buildFlowstarterClerkUserButtonAppearance`) so the profile dropdown matches
 * `ClerkThemeWrapper` on flowstarter-main. Never add `filter` / `drop-shadow`
 * on `userButtonPopoverRootBox` — see module JSDoc on that package.
 *
 * Sign-out uses a custom `UserButton.Action`; Clerk still renders its built-in
 * row — `@flowstarter/flow-design-system/clerk-account.css` hides it via
 * `FLOWSTARTER_CLERK_BUILTIN_SIGN_OUT_ROW_SELECTOR`.
 */
function resolveCssVar(varName: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return value || fallback;
}

/* ── Theme switcher ───────────────────────────────────────────────────────
   Shared `<ThemeToggle />` from `@flowstarter/flow-design-system` (same
   component and default sizing as flowstarter-main’s `theme-toggle.tsx`).
   `resolvedTheme` is passed through so the pill matches the editor document
   (`useTheme` + localStorage). Use `compact` only when you intentionally want
   smaller hit targets; header uses default sizing for platform parity. */
export function EditorThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme, resolvedTheme } = useTheme();

  return (
    <div
      className="flex h-[var(--fs-chrome-control-h)] shrink-0 flex-row flex-nowrap items-center"
      data-fs="editor-theme-switcher"
    >
      <ThemeToggle
        theme={theme}
        onThemeChange={setTheme}
        resolvedTheme={resolvedTheme}
        compact={compact}
        {...(compact ? { className: "leading-none" } : {})}
      />
    </div>
  );
}

/* ── Account chip ─────────────────────────────────────────────────────────
   Signed-in user chrome: Clerk <UserButton/> + email + tier/workspace
   caption. Used in the editor header (compact / container-aware) or
   legacy sidebar footer.

   Branches:
     1. Signed in: real avatar (opens dropdown) + identifiers.
     2. Signed out: sign-in button (Clerk modal, no bounce).
     3. Clerk auth loading: placeholder until `useAuth().isLoaded` (avoids mounting
        `UserButton` before the session is ready — fixes dead clicks / popover).

   Flat-on-paper — no inset card. */
export function EditorAccountChip({ variant = "sidebar" }: { variant?: "sidebar" | "header" }) {
  const tier = useTier();
  const { isLoaded: clerkAuthLoaded } = useAuth();
  const { isLoaded, user } = useUser();
  const { signOut, openUserProfile } = useClerk();
  const { resolvedTheme } = useTheme();
  const clerkAppearance = buildFlowstarterClerkUserButtonAppearance({
    isDark: resolvedTheme === "dark",
    resolveVar: resolveCssVar,
    editorChrome: true,
    applyEditorFontStacks: true,
  });

  // Sign-out confirmation. Clerk's UserButton popover auto-closes
  // when an action runs, which would race with a dialog opened
  // synchronously inside the action's handler. Setting this state
  // from the action's onClick lets the popover close cleanly; the
  // dialog renders at this component's top level so it survives.
  const [signOutDialogOpen, setSignOutDialogOpen] = useState(false);

  const workspaceLabel = tier.currentWorkspace?.name ?? "Personal";
  // Tier caption: admins see "Admin"; clients see their tier label.
  const tierLineIsAdminLabel = tier.role === "admin";
  const tierLine = tierLineIsAdminLabel
    ? "Admin"
    : tier.tier.charAt(0).toUpperCase() + tier.tier.slice(1);
  // User initial (not workspace) — derive from the Clerk user's name or
  // email so the avatar reads as "this person" instead of "Personal → P".
  const userPrimaryEmail = user?.primaryEmailAddress?.emailAddress ?? "";
  const userInitial = (
    user?.firstName?.trim()[0] ??
    user?.fullName?.trim()[0] ??
    userPrimaryEmail.trim()[0] ??
    "?"
  ).toUpperCase();
  const userImageUrl = user?.imageUrl?.trim() || null;
  const userDisplayName =
    user?.fullName?.trim() ||
    user?.firstName?.trim() ||
    userPrimaryEmail.split("@")[0] ||
    workspaceLabel;
  // Workspace initial — only used by the legacy sidebar variant; the
  // header variant now shows the actual signed-in user's avatar.
  const initial = (workspaceLabel.trim()[0] ?? "?").toUpperCase();

  // `editorOriginUrl()` keeps the redirect under `/editor/` on a sub-path
  // deploy — a bare `window.location.origin` would bounce Clerk's
  // post-sign-out redirect to the tenant's own site content instead.
  const stayOnEditorUrl = editorOriginUrl();
  const signOutAndRevoke = async () => {
    try {
      await fetch(withBasePath("/api/auth/sign-out"), {
        method: "POST",
        credentials: "include",
      });
    } catch (_) {
      /* ignore */
    }
    await signOut({ redirectUrl: stayOnEditorUrl });
  };

  // Flat-on-paper chip: no border, no fill, no glass. Just an avatar
  // + caption sitting on the sidebar's paper bg. Editorial concierge.
  const chipStyle: CSSProperties = {
    background: "transparent",
    border: "0",
  };

  const isHeader = variant === "header";
  const signedInRowClass = isHeader
    ? "box-border flex h-[var(--fs-chrome-control-h)] max-h-[var(--fs-chrome-control-h)] min-h-[var(--fs-chrome-control-h)] min-w-0 max-w-full shrink-0 items-center gap-2 py-0 pr-0 pl-0 @[36rem]/chrome-tools:gap-2.5 @[36rem]/chrome-tools:px-1"
    : "flex w-full items-center gap-2.5 px-1 py-1";
  const captionWrapClass = isHeader
    ? "pointer-events-none hidden min-h-0 min-w-0 flex-1 flex-col justify-center gap-0 leading-none @[36rem]/chrome-tools:flex"
    : "flex min-w-0 flex-1 flex-col leading-tight";

  const Avatar = (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center text-[11px] font-semibold text-white"
      style={{
        borderRadius: 7,
        background:
          "linear-gradient(135deg, hsl(233, 65%, 50%) 0%, hsl(233, 75%, 60%) 50%, hsl(180, 65%, 55%) 100%)",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.32) inset, 0 2px 6px rgba(78,94,218,0.22)",
      }}
    >
      {initial}
    </span>
  );

  const Caption = ({
    primary,
    secondarySentenceCase = false,
  }: {
    primary: string;
    secondarySentenceCase?: boolean;
  }) => (
    <span className={captionWrapClass}>
      <span
        className={
          isHeader
            ? "truncate text-xs font-semibold leading-none"
            : "truncate text-[12px] font-semibold leading-tight"
        }
        style={{ color: "var(--fs-ink)", letterSpacing: "-0.005em" }}
      >
        {primary}
      </span>
      <span
        className={isHeader ? "truncate text-xs font-medium leading-none" : "truncate text-[9px] font-medium"}
        style={{
          color: "var(--fs-ink-mono)",
          letterSpacing: secondarySentenceCase
            ? "0.04em"
            : isHeader
              ? "0.14em"
              : "0.22em",
          textTransform: secondarySentenceCase ? "none" : "uppercase",
          fontFamily: "var(--fs-font-mono)",
        }}
      >
        {tierLine}
      </span>
    </span>
  );

  return (
    <>
      {!clerkAuthLoaded ? (
        <div
          className={
            isHeader
              ? "box-border inline-flex h-[var(--fs-chrome-control-h,32px)] max-h-[var(--fs-chrome-control-h,32px)] min-h-[var(--fs-chrome-control-h,32px)] min-w-[7.5rem] shrink-0 animate-pulse rounded-[var(--fs-chrome-control-radius)] bg-[var(--fs-accent-bg)]"
              : "flex w-full items-center gap-2.5 px-1 py-1"
          }
          aria-hidden
        >
          {isHeader ? null : (
            <>
              {Avatar}
              <Caption primary={workspaceLabel} secondarySentenceCase={tierLineIsAdminLabel} />
            </>
          )}
        </div>
      ) : null}
      {clerkAuthLoaded ? (
        <>
          <SignedIn>
            <div
              className={signedInRowClass}
              style={chipStyle}
              data-fs="editor-account-chip"
            >
              {/* Header variant: custom DropdownMenu mirroring the main
                  platform's `<UserMenu>` (apps/flowstarter-main/src/
                  components/ui/user-menu.tsx). Sidebar variant keeps the
                  Clerk `<UserButton>` since it lives in a different chrome
                  context. Both still open Clerk's User Profile modal for
                  account management via `openUserProfile`. */}
              {isHeader ? (
                <Menu>
                  {/* Trigger: Clerk user avatar image when set, otherwise
                      the initial of the user's name/email over the brand
                      gradient. Sized to chrome control height so it lines
                      up with Preview/Files and Publish next to it. */}
                  <MenuTrigger
                    className="relative z-30 flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-semibold text-white outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    style={
                      userImageUrl
                        ? undefined
                        : {
                            background:
                              "linear-gradient(135deg, hsl(233, 65%, 50%) 0%, hsl(233, 75%, 60%) 50%, hsl(180, 65%, 55%) 100%)",
                            boxShadow:
                              "0 1px 0 rgba(255,255,255,0.32) inset, 0 2px 6px rgba(78,94,218,0.22)",
                          }
                    }
                    aria-label="Account menu"
                  >
                    {userImageUrl ? (
                      <img
                        src={userImageUrl}
                        alt={userDisplayName}
                        className="size-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      userInitial
                    )}
                  </MenuTrigger>
                  <MenuPopup
                    align="end"
                    sideOffset={10}
                    showArrow
                    className="w-72 p-0"
                  >
                    {/* Profile header — avatar + name + email, bordered
                        bottom (matches main platform's UserMenu). */}
                    <div className="flex items-center gap-3 border-b border-[var(--fs-rule)] px-3 py-3">
                      <span
                        aria-hidden
                        className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-semibold text-white"
                        style={
                          userImageUrl
                            ? undefined
                            : {
                                background:
                                  "linear-gradient(135deg, hsl(233, 65%, 50%) 0%, hsl(233, 75%, 60%) 50%, hsl(180, 65%, 55%) 100%)",
                                boxShadow:
                                  "0 1px 0 rgba(255,255,255,0.32) inset, 0 2px 6px rgba(78,94,218,0.22)",
                              }
                        }
                      >
                        {userImageUrl ? (
                          <img
                            src={userImageUrl}
                            alt={userDisplayName}
                            className="size-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          userInitial
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p
                          className="truncate text-sm font-medium"
                          style={{ color: "var(--fs-ink)" }}
                        >
                          {userDisplayName}
                        </p>
                        <p
                          className="truncate text-xs"
                          style={{ color: "var(--fs-ink-faint)" }}
                        >
                          {userPrimaryEmail || workspaceLabel}
                        </p>
                      </div>
                    </div>

                    {/* Manage account — opens Clerk's User Profile modal
                        with the same Flowstarter appearance the legacy
                        `<UserButton>` used. */}
                    <div className="p-1">
                      <MenuItem
                        onClick={() => {
                          openUserProfile({ appearance: clerkAppearance });
                        }}
                      >
                        <UserIcon className="size-4" />
                        Manage account
                      </MenuItem>
                    </div>

                    <MenuSeparator />

                    <div className="p-1">
                      <MenuItem
                        onClick={() => setSignOutDialogOpen(true)}
                        className="data-highlighted:bg-destructive/12 text-destructive data-highlighted:text-destructive"
                      >
                        <LogOutIcon className="size-4" />
                        Sign out
                      </MenuItem>
                    </div>
                  </MenuPopup>
                </Menu>
              ) : (
                <div className="relative z-30 flex h-full shrink-0 items-center">
                  <UserButton
                    afterSignOutUrl={stayOnEditorUrl}
                    appearance={clerkAppearance}
                    userProfileProps={{ appearance: clerkAppearance }}
                  >
                    <UserButton.MenuItems>
                      <UserButton.Action label="manageAccount" />
                      <UserButton.Action
                        label="Sign out"
                        labelIcon={<LogOutIcon className="size-3.5" />}
                        onClick={() => setSignOutDialogOpen(true)}
                      />
                    </UserButton.MenuItems>
                  </UserButton>
                </div>
              )}
              <Caption
                primary={
                  isLoaded && user?.primaryEmailAddress
                    ? user.primaryEmailAddress.emailAddress
                    : workspaceLabel
                }
                secondarySentenceCase={tierLineIsAdminLabel}
              />
            </div>
          </SignedIn>
          <SignedOut>
            <SignInButton
              mode="modal"
              forceRedirectUrl={stayOnEditorUrl}
              appearance={clerkAppearance}
            >
              <button
                type="button"
                className={
                  isHeader
                    ? "box-border flex h-[var(--fs-chrome-control-h)] max-h-[var(--fs-chrome-control-h)] min-h-[var(--fs-chrome-control-h)] max-w-full shrink-0 items-center gap-2 rounded-md py-0 pr-0 pl-0 text-left transition-colors hover:bg-[var(--fs-accent-bg)] @[36rem]/chrome-tools:gap-2.5 @[36rem]/chrome-tools:px-1"
                    : "flex w-full items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-[var(--fs-accent-bg)]"
                }
                style={chipStyle}
                aria-label="Sign in"
              >
                {Avatar}
                <Caption primary="Sign in" secondarySentenceCase={tierLineIsAdminLabel} />
                <LogInIcon
                  className="size-3.5 shrink-0"
                  style={{ color: "var(--fs-ink-faint)" }}
                />
              </button>
            </SignInButton>
          </SignedOut>
        </>
      ) : null}

      {/* Sign-out confirmation — opened from custom MenuItems row; built-in
          Clerk sign-out control is display:none (`clerk-account.css`). */}
      <AlertDialog
        open={signOutDialogOpen}
        onOpenChange={setSignOutDialogOpen}
      >
        <AlertDialogPopup className="sm:max-w-[440px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out?</AlertDialogTitle>
            <AlertDialogDescription>
              This will end your editor session and return you to the
              sign-in page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setSignOutDialogOpen(false);
                void signOutAndRevoke();
              }}
            >
              Sign out
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
