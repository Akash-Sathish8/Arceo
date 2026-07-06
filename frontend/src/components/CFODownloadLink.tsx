/**
 * The actual @react-pdf/renderer download link, split into its own module so
 * it can be React.lazy'd out of the main bundle (@react-pdf is ~1MB). Nothing
 * here is imported eagerly — only when a user actually opens an export.
 */

import { PDFDownloadLink } from "@react-pdf/renderer"
import { FileDown } from "lucide-react"
import { CFOReport } from "@/components/CFOReport"
import type { CFOReportData } from "@/lib/cfoReport"
import type { ReactNode } from "react"

interface Props {
  data: CFOReportData
  fileName: string
  className: string
  style: React.CSSProperties
  label: ReactNode
}

export default function CFODownloadLink({ data, fileName, className, style, label }: Props) {
  return (
    <PDFDownloadLink document={<CFOReport data={data} />} fileName={fileName} className={className} style={style}>
      {({ loading: building, error }) =>
        error
          ? (<><FileDown size={13} /> Export failed — retry</>)
          : building
          ? (<><FileDown size={13} /> Building PDF…</>)
          : label
      }
    </PDFDownloadLink>
  )
}
