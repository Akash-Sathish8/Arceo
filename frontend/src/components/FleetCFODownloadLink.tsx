/**
 * Fleet CFO PDF download link — split out so @react-pdf/renderer (~1MB) is
 * lazy-loaded, not baked into the main bundle.
 */

import { PDFDownloadLink } from "@react-pdf/renderer"
import { FileText } from "lucide-react"
import { FleetCFOReport, type FleetReportData } from "@/components/FleetCFOReport"

export default function FleetCFODownloadLink({ data, fileName }: { data: FleetReportData; fileName: string }) {
  return (
    <PDFDownloadLink
      document={<FleetCFOReport data={data} />}
      fileName={fileName}
      className="btn btn--secondary"
    >
      {({ loading: building, error }) =>
        error
          ? (<><FileText size={14} /> Export failed, retry</>)
          : building
          ? (<><FileText size={14} /> Building PDF…</>)
          : (<><FileText size={14} /> CFO report (PDF)</>)
      }
    </PDFDownloadLink>
  )
}
