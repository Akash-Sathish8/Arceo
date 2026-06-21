import AnnouncementBar from "@/components/AnnouncementBar";
import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import ProblemStatement from "@/components/ProblemStatement";
import HowItWorks from "@/components/HowItWorks";
import ProductVisual from "@/components/ProductVisual";
import FeatureRows from "@/components/FeatureRows";
import CTABanner from "@/components/CTABanner";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <AnnouncementBar />
      <Navbar />
      <main>
        <Hero />
        <ProblemStatement />
        <HowItWorks />
        <ProductVisual />
        <FeatureRows />
        <CTABanner />
      </main>
      <Footer />
    </>
  );
}
