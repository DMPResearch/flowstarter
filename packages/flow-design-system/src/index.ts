/**
 * @flowstarter/flow - Flowstarter Design System
 *
 * Shared UI components and design tokens for all Flowstarter apps.
 */

// Components - Brand
export { Logo, LogoIcon, LogoMark, type LogoProps } from './components/Logo';
export { LoadingScreen } from './components/LoadingScreen';
export { ThemeToggle, type ThemeToggleProps } from './components/ThemeToggle';

// Components - Auth (SDK-agnostic; deps injected via props)
export {
  LoginForm,
  isValidEmail,
  type LoginFormProps,
  type SharedSignInResource,
  type SharedSignInResult,
  type SharedSetActive,
  type SharedTranslate,
} from './components/auth/LoginForm';

// Components - Buttons
export {
  Button,
  getButtonStyles,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from './components/buttons/Button';

// Components - Cards
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  type CardProps,
} from './components/cards/Card';

// Components - Inputs
export { Input, type InputProps } from './components/inputs/Input';

// Components - Feedback
export { Spinner } from './components/feedback/Spinner';
export {
  StatusDot,
  type StatusDotProps,
} from './components/feedback/StatusDot';

// Components - Backgrounds
export {
  FlowBackground,
  type FlowBackgroundProps,
  type FlowBackgroundVariant,
} from './components/backgrounds/FlowBackground';
export {
  AmbientGlow,
  type AmbientGlowProps,
} from './components/backgrounds/AmbientGlow';
export {
  MeshBackdrop,
  type MeshBackdropProps,
  type MeshBackdropVariant,
} from './components/backgrounds/MeshBackdrop';

// Components - Liquid glass surfaces
// The one glass material. Nothing else in the product should hand-roll a
// backdrop-filter, a translucent fill or a gradient border.
export {
  GlassSurface,
  TONES,
  type GlassSurfaceProps,
  type GlassSurfaceVariant,
  type Tone,
} from './components/surfaces/GlassSurface';
export { StatTile, type StatTileProps } from './components/surfaces/StatTile';
export {
  Pill,
  type PillProps,
  type PillSize,
} from './components/surfaces/Pill';

// Components - Layout
export {
  GlassPanel,
  type GlassPanelProps,
} from './components/layout/GlassPanel';
export {
  ScrollAwareHeader,
  type ScrollAwareHeaderProps,
} from './components/layout/ScrollAwareHeader';
export {
  Footer,
  type FooterProps,
  type FooterLink,
} from './components/layout/Footer';

// Components - Cards (extended)
export { GlassCard, type GlassCardProps } from './components/cards/GlassCard';
export { StatCard, type StatCardProps } from './components/cards/StatCard';

// Design Tokens
export * from './tokens';

// Utilities
export {
  CLIENT_REDIRECT_PATH,
  TEAM_REDIRECT_PATH,
  currentOrigin,
  toSameOriginPath,
  toTrustedHandoffUrl,
} from './utils/safe-redirect';
export {
  getTheme,
  setTheme,
  getEffectiveTheme,
  applyTheme,
  initTheme,
  type Theme,
} from './utils/theme';
