import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'signal' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** Shared class builder so router <Link>s can be styled as buttons too. */
export function btnClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  extra?: string,
): string {
  return [
    'btn',
    `btn--${variant}`,
    size !== 'md' ? `btn--${size}` : '',
    extra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  iconLeft?: IconName;
  iconRight?: IconName;
  children: ReactNode;
};

export function Button({
  variant = 'primary',
  size = 'md',
  block,
  iconLeft,
  iconRight,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={btnClass(variant, size, [block ? 'btn--block' : '', className ?? ''].join(' '))}
      {...rest}
    >
      {iconLeft && <Icon className="btn__icon" name={iconLeft} size={18} />}
      {children}
      {iconRight && <Icon className="btn__icon btn__arrow" name={iconRight} size={18} />}
    </button>
  );
}
