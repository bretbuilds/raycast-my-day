// Generates assets/extension-icon.png (512×512): rounded square with a sunrise bar and a check mark.
import AppKit

let size = 512.0
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
let rect = CGRect(x: 0, y: 0, width: size, height: size)
let path = CGPath(roundedRect: rect.insetBy(dx: 8, dy: 8), cornerWidth: 110, cornerHeight: 110, transform: nil)
ctx.addPath(path)
ctx.clip()
let colors = [NSColor(calibratedRed: 0.98, green: 0.55, blue: 0.20, alpha: 1).cgColor,
              NSColor(calibratedRed: 0.55, green: 0.22, blue: 0.65, alpha: 1).cgColor] as CFArray
let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size), end: CGPoint(x: size, y: 0), options: [])
// Agenda lines
ctx.setStrokeColor(NSColor(calibratedWhite: 1, alpha: 0.55).cgColor)
ctx.setLineWidth(22)
ctx.setLineCap(.round)
for (i, len) in [220.0, 160.0, 190.0].enumerated() {
    let y = 380.0 - Double(i) * 70
    ctx.move(to: CGPoint(x: 230, y: y)); ctx.addLine(to: CGPoint(x: 230 + len, y: y))
}
// Check mark
ctx.setStrokeColor(NSColor.white.cgColor)
ctx.setLineWidth(44)
ctx.setLineJoin(.round)
ctx.move(to: CGPoint(x: 92, y: 250)); ctx.addLine(to: CGPoint(x: 160, y: 170)); ctx.addLine(to: CGPoint(x: 300, y: 330))
ctx.strokePath()
image.unlockFocus()
let tiff = image.tiffRepresentation!
let png = NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: "assets/extension-icon.png"))
print("wrote assets/extension-icon.png")
