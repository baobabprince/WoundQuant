"""Network used by WoundQuant's neural engine.

A small U-Net that works on the analysis grid produced by the app
(see js/core/pipeline.js → modelInput):

    input   1 × 4 × H × W   float32 in 0–1   (mean grey, texture, relative texture, growth-area mask)
    output  1 × 1 × H × W   logits of "cell-free" (wound or otherwise empty)

H and W may be anything divisible by 32. The first convolution halves the
resolution and the result is upsampled at the end, which keeps in-browser
inference (WebAssembly, single thread) well under a second per image.
"""

import torch
from torch import nn
import torch.nn.functional as F


def block(cin: int, cout: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
        nn.Conv2d(cout, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
    )


class TinyUNet(nn.Module):
    def __init__(self, in_channels: int = 4, width: int = 16):
        super().__init__()
        c = width
        self.stem = nn.Sequential(
            nn.Conv2d(in_channels, c, 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(c), nn.ReLU(inplace=True),
            nn.Conv2d(c, c, 3, padding=1, bias=False), nn.BatchNorm2d(c), nn.ReLU(inplace=True),
        )
        self.enc2 = block(c, 2 * c)
        self.enc3 = block(2 * c, 4 * c)
        self.mid = block(4 * c, 8 * c)
        self.dec3 = block(8 * c + 4 * c, 4 * c)
        self.dec2 = block(4 * c + 2 * c, 2 * c)
        self.dec1 = block(2 * c + c, c)
        self.head = nn.Conv2d(c, 1, 1)

    @staticmethod
    def _up(x: torch.Tensor) -> torch.Tensor:
        return F.interpolate(x, scale_factor=2.0, mode="bilinear", align_corners=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        e1 = self.stem(x)                      # 1/2
        e2 = self.enc2(F.max_pool2d(e1, 2))    # 1/4
        e3 = self.enc3(F.max_pool2d(e2, 2))    # 1/8
        m = self.mid(F.max_pool2d(e3, 2))      # 1/16
        d3 = self.dec3(torch.cat([self._up(m), e3], 1))
        d2 = self.dec2(torch.cat([self._up(d3), e2], 1))
        d1 = self.dec1(torch.cat([self._up(d2), e1], 1))
        return self._up(self.head(d1))         # back to 1/1
