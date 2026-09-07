import AnnouncementBar from "@/components/AnnouncementBar";
import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import MetricStrip from "@/components/MetricStrip";
import ProblemStatement from "@/components/ProblemStatement";
import BlastRadius from "@/components/BlastRadius";
import HowItWorks from "@/components/HowItWorks";
import CrossAgent from "@/components/CrossAgent";
import FeatureRows from "@/components/FeatureRows";
import PullRequest from "@/components/PullRequest";
import Positioning from "@/components/Positioning";
import Proof from "@/components/Proof";
import CTABanner from "@/components/CTABanner";
import Footer from "@/components/Footer";

/* Section rhythm is deliberate, and it alternates rather than running one tone
   the whole way down:

     hero        light, ruled      the tape — a call stream, live
     metrics     light band        three figures, divided
     problem     light paper       the ledger — cost beside blast weight
     blast       light ground      the bench — how a score is built
     how         DARK act          the graph as subject, timeline
     cross       light ground      two agents, one chain across the handoff
     features    light paper       bands, sensitivity, the matrix
     pr          light ground      the CI check, on a dark panel
     positioning light paper       what Arceo is, and is not
     proof       light ground      backtest, framework mapping, audit
     cta         DARK              high contrast, close

   No two graphics share a family: a stream, a list, a mechanism, a network, a
   handoff, a band chart, a bar chart, a matrix and a checks list. Dark is a
   chapter here, never an accident — and the page darkens toward the close.

   The pull-request section sits late on purpose. It is the surface the person
   who has to ADOPT Arceo meets first, so it earns a place; but Arceo is a
   runtime product, and opening on a CI check would tell a CIO they are buying
   a linter. Everything above says what the product knows. This says where it
   shows up.

   Positioning and Proof are kept from the previous design and left last, where
   a reader who is already convinced goes looking for the receipts. Proof in
   particular carries figures nothing else on the page does — the 829-call
   backtest and the audit result. */

export default function Home() {
  return (
    <>
      <a href="#main" className="skip-link">Skip to content</a>
      <AnnouncementBar />
      <Navbar />
      <main id="main" style={{ overflowX: "clip", width: "100%" }}>
        <Hero />
        <MetricStrip />
        <ProblemStatement />
        <BlastRadius />
        <HowItWorks />
        <CrossAgent />
        <FeatureRows />
        <PullRequest />
        <Positioning />
        <Proof />
        <CTABanner />
      </main>
      <Footer />
    </>
  );
}
