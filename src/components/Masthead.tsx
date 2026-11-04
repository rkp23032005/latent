import { useState } from 'react';
import { Link } from 'react-router-dom';
import { brand } from '../brand';
import { Icon } from './Icon';
import { UploadButton } from './UploadButton';
import { Wordmark } from './Wordmark';

const sections = [
  { href: '/#workflow', label: 'Workflow' },
  { href: '/#looks', label: 'Looks' },
  { href: '/edit', label: 'Editor' },
];

export function Masthead() {
  const [open, setOpen] = useState(false);

  return (
    <header className="masthead">
      <div className="shell masthead__inner">
        <Wordmark />

        <nav className="masthead__nav" aria-label="Primary">
          <ul className="masthead__links">
            {sections.map((section) => (
              <li key={section.href}>
                <Link className="masthead__link" to={section.href} onClick={() => setOpen(false)}>
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>

          <UploadButton
            id="masthead-upload-input"
            label="Upload a photo"
            size="sm"
            className="masthead__cta"
          />

          <button
            className="masthead__burger"
            type="button"
            aria-expanded={open}
            aria-controls="mobile-sections"
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? 'close' : 'menu'} size={20} label="Toggle sections" />
          </button>
        </nav>
      </div>

      {open && (
        <nav className="masthead__drawer" id="mobile-sections" aria-label="Sections">
          <ul>
            {sections.map((section) => (
              <li key={section.href}>
                <Link className="masthead__link" to={section.href} onClick={() => setOpen(false)}>
                  {section.label}
                  <Icon name="arrowRight" size={18} />
                </Link>
              </li>
            ))}
          </ul>
          <p className="meta meta--micro">{brand.promise}</p>
        </nav>
      )}
    </header>
  );
}
