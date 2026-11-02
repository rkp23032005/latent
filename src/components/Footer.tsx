import { Link } from 'react-router-dom';
import { brand } from '../brand';
import { Icon } from './Icon';
import { Wordmark } from './Wordmark';

export function Footer() {
  return (
    <footer className="foot">
      <div className="shell">
        <div className="foot__grid">
          <div className="foot__col foot__col--lede">
            <Wordmark />
            <p className="body-muted" style={{ maxWidth: '34ch', fontSize: 'var(--t-small)' }}>
              {brand.promise}
            </p>
            <p className="meta meta--micro">
              Runs entirely in your browser. Your photograph never leaves this device.
            </p>
          </div>

          <div className="foot__col">
            <h2 className="caps">Product</h2>
            <ul className="foot__list">
              <li>
                <Link to="/#looks">Looks</Link>
              </li>
              <li>
                <Link to="/#workflow">Workflow</Link>
              </li>
              <li>
                <Link to="/#upload">Upload a photo</Link>
              </li>
              <li>
                <Link to="/edit">Open the editor</Link>
              </li>
            </ul>
          </div>

          <div className="foot__col">
            <h2 className="caps">Notes</h2>
            <ul className="foot__list">
              <li>
                <span className="body-muted">Brand name is a working title.</span>
              </li>
              <li>
                <span className="body-muted">Editing engine: live, in this tab.</span>
              </li>
              <li>
                <a
                  href="https://picsum.photos"
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  Placeholder photographs
                  <Icon size={14} name="arrowRight" />
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="foot__bar">
          <span className="meta meta--micro">
            © {new Date().getFullYear()} {brand.name} — {brand.roll}
          </span>
          <span className="meta meta--micro">No account. No upload. No watermark.</span>
        </div>
      </div>
    </footer>
  );
}
