import {
  Store,
  ShoppingCart,
  ShoppingBag,
  Mail,
  MessageCircle,
  Globe,
  HelpCircle,
  type LucideIcon,
} from 'lucide-react';

interface ChannelStyle {
  Icon: LucideIcon;
  classes: string;
}

const CHANNEL_STYLES: Record<string, ChannelStyle> = {
  rakuten: {
    Icon: Store,
    classes: 'bg-red-50 text-red-700 border-red-200',
  },
  amazon: {
    Icon: ShoppingCart,
    classes: 'bg-amber-50 text-amber-800 border-amber-300',
  },
  yahoo: {
    Icon: ShoppingBag,
    classes: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200',
  },
  email: {
    Icon: Mail,
    classes: 'bg-slate-50 text-slate-700 border-slate-200',
  },
  line: {
    Icon: MessageCircle,
    classes: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  own_ec: {
    Icon: Globe,
    classes: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  },
};

const FALLBACK: ChannelStyle = {
  Icon: HelpCircle,
  classes: 'bg-gray-50 text-gray-600 border-gray-200',
};

interface Props {
  code: string | null | undefined;
  displayName: string | null | undefined;
  size?: 'sm' | 'md';
}

export default function ChannelBadge({ code, displayName, size = 'sm' }: Props) {
  const style = (code && CHANNEL_STYLES[code]) || FALLBACK;
  const Icon = style.Icon;
  const sizeCls = size === 'md' ? 'px-2.5 py-1 text-xs gap-1.5' : 'px-2 py-0.5 text-[10px] gap-1';
  const iconSize = size === 'md' ? 12 : 10;
  return (
    <span
      className={`inline-flex items-center rounded-full border font-medium ${style.classes} ${sizeCls}`}
    >
      <Icon size={iconSize} strokeWidth={2} />
      <span>{displayName ?? code ?? '不明'}</span>
    </span>
  );
}
