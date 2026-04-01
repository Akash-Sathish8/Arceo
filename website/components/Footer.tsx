const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";

const TwitterX = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M9.294 6.928L14.357 1h-1.2L8.762 6.147 5.25 1H1l5.31 7.733L1 15h1.2l4.642-5.4L10.75 15H15L9.294 6.928zm-1.644 1.91l-.538-.77L2.64 1.89h1.843l3.454 4.942.537.768 4.49 6.42h-1.843L7.65 8.838z"/>
  </svg>
);

const GitHub = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 1a7 7 0 00-2.213 13.641c.35.064.479-.152.479-.337 0-.166-.006-.606-.009-1.19-1.947.423-2.358-.94-2.358-.94-.319-.81-.778-1.026-.778-1.026-.636-.435.048-.426.048-.426.703.049 1.073.722 1.073.722.624 1.069 1.638.76 2.037.581.063-.452.244-.76.444-.935-1.554-.177-3.188-.777-3.188-3.458 0-.764.273-1.388.72-1.878-.072-.177-.312-.888.069-1.85 0 0 .587-.189 1.924.717A6.71 6.71 0 018 5.379a6.71 6.71 0 011.751.236c1.336-.906 1.923-.717 1.923-.717.382.962.141 1.673.069 1.85.448.49.72 1.114.72 1.878 0 2.688-1.637 3.279-3.196 3.453.251.217.475.645.475 1.3 0 .938-.009 1.694-.009 1.924 0 .187.127.405.482.337A7.001 7.001 0 008 1z"/>
  </svg>
);

const LinkedIn = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M3.34 4.47A1.34 1.34 0 103.34 1.8a1.34 1.34 0 000 2.67zM2.13 5.73h2.42V14H2.13V5.73zM9.07 5.73H6.65V14h2.42V9.73c0-2.28 2.95-2.47 2.95 0V14H14.4V9.12c0-3.81-4.32-3.67-5.33-1.79v-1.6z"/>
  </svg>
);

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <span className="footer-logo">
          Arceo<span className="nav-logo-dot" />
        </span>

        <nav className="footer-links">
          <a href="#features" className="footer-link">Features</a>
          <a href="#pricing"  className="footer-link">Pricing</a>
          <a href={`${APP_URL}/login`} className="footer-link">Sign in</a>
          <a href={`${APP_URL}/login?signup=true`} className="footer-link">Get started</a>
          <a href="mailto:support@arceo.ai" className="footer-link">Support</a>
          <a href="#" className="footer-link">Privacy</a>
          <a href="#" className="footer-link">Terms</a>
        </nav>

        <div className="footer-social">
          <a href="https://twitter.com/arceo_ai" className="footer-social-link" aria-label="X / Twitter" target="_blank" rel="noopener noreferrer">
            <TwitterX />
          </a>
          <a href="https://github.com/arceo-ai" className="footer-social-link" aria-label="GitHub" target="_blank" rel="noopener noreferrer">
            <GitHub />
          </a>
          <a href="https://linkedin.com/company/arceo-ai" className="footer-social-link" aria-label="LinkedIn" target="_blank" rel="noopener noreferrer">
            <LinkedIn />
          </a>
        </div>

        <span className="footer-copy">© {new Date().getFullYear()} Arceo</span>
      </div>
    </footer>
  );
}
