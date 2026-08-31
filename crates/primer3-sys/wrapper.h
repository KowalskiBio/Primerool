/* Curated subset of Primer3's C headers to bind: thermodynamic primitives
 * (thal/oligotm/thal_parameters) plus the picking-engine header
 * (libprimer3.h — plain C in this vendored primer3-py fork, unlike
 * upstream primer3-org's libprimer3.cc). bindgen's allowlist in build.rs
 * keeps the generated surface scoped to what's actually used, even though
 * this header pulls in primer3's full internal type graph.
 */
#include "thal.h"
#include "oligotm.h"
#include "thal_parameters.h"
#include "libprimer3.h"
