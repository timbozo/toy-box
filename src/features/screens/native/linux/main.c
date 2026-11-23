#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/Xutil.h>
#include <X11/extensions/XTest.h>
#include <jpeglib.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

typedef struct {
  Window window;
  pid_t process_id;
  char process_start[32];
} ScreenIdentity;

typedef struct {
  Window window;
  pid_t process_id;
  char process_start[32];
  char id[96];
  char title[256];
  atomic_int max_width;
  atomic_int max_height;
  int sequence;
  atomic_int running;
  int thread_started;
  pthread_t thread;
} Capture;

static Capture **captures = NULL;
static size_t capture_count = 0;
static pthread_mutex_t writer_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t x_lock = PTHREAD_MUTEX_INITIALIZER;
static Display *display;
static int held_keys[256];
static int held_buttons[8];
static double scroll_remainders[2];
static KeyCode unicode_keycode;
static KeySym *unicode_keymap;
static int unicode_keymap_width;
static Window unicode_keymap_window;
static int unicode_keymap_changed;

static int ignore_x_error(Display *display, XErrorEvent *event) {
  (void)display;
  (void)event;
  return 0;
}

static void put_u32(unsigned char *bytes, uint32_t value) {
  bytes[0] = (unsigned char)(value >> 24);
  bytes[1] = (unsigned char)(value >> 16);
  bytes[2] = (unsigned char)(value >> 8);
  bytes[3] = (unsigned char)value;
}

static void send_packet(const char *json, const unsigned char *payload, size_t payload_size) {
  size_t json_size = strlen(json);
  unsigned char header[8];
  put_u32(header, (uint32_t)json_size);
  put_u32(header + 4, (uint32_t)payload_size);
  pthread_mutex_lock(&writer_lock);
  fwrite(header, 1, sizeof(header), stdout);
  fwrite(json, 1, json_size, stdout);
  if (payload_size) fwrite(payload, 1, payload_size, stdout);
  fflush(stdout);
  pthread_mutex_unlock(&writer_lock);
}

static void append_json_string(char *json, size_t capacity, size_t *offset, const char *value) {
  if (*offset + 1 >= capacity) return;
  json[(*offset)++] = '"';
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*offset + 7 >= capacity) break;
    if (*p == '"' || *p == '\\') {
      json[(*offset)++] = '\\';
      json[(*offset)++] = (char)*p;
    } else if (*p < 0x20) {
      *offset += (size_t)snprintf(json + *offset, capacity - *offset, "\\u%04x", *p);
    } else {
      json[(*offset)++] = (char)*p;
    }
  }
  json[(*offset)++] = '"';
  json[*offset] = 0;
}

static void send_reply(int id, int ok, const char *value, const unsigned char *payload,
                       size_t payload_size) {
  char json[4096];
  int length = snprintf(json, sizeof(json),
                        "{\"type\":\"reply\",\"requestId\":%d,\"ok\":%s,\"%s\":",
                        id, ok ? "true" : "false", ok ? "value" : "error");
  size_t offset = length > 0 ? (size_t)length : 0;
  append_json_string(json, sizeof(json), &offset, value ? value : "");
  snprintf(json + offset, sizeof(json) - offset, "}");
  send_packet(json, payload, payload_size);
}

static int json_int(const char *json, const char *key) {
  char needle[128];
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  const char *p = strstr(json, needle);
  if (!p) return 0;
  p = strchr(p, ':');
  return p ? atoi(p + 1) : 0;
}

static int json_string(const char *json, const char *key, char *value, size_t value_size) {
  char needle[128];
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  const char *p = strstr(json, needle);
  if (!p) return 0;
  p = strchr(p, ':');
  if (!p) return 0;
  p = strchr(p + 1, '"');
  if (!p) return 0;
  p++;
  size_t i = 0;
  while (*p && *p != '"' && i + 1 < value_size) {
    if (*p != '\\') {
      value[i++] = *p++;
      continue;
    }
    p++;
    switch (*p) {
      case '"': case '\\': case '/': value[i++] = *p++; break;
      case 'n': value[i++] = '\n'; p++; break;
      case 'r': value[i++] = '\r'; p++; break;
      case 't': value[i++] = '\t'; p++; break;
      case 'b': value[i++] = '\b'; p++; break;
      case 'f': value[i++] = '\f'; p++; break;
      default: value[i++] = *p ? *p++ : '\\'; break;
    }
  }
  value[i] = 0;
  return i != 0;
}

static int json_bool(const char *json, const char *key, int fallback) {
  char needle[128];
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  const char *value = strstr(json, needle);
  if (!value || !(value = strchr(value, ':'))) return fallback;
  value++;
  while (*value == ' ' || *value == '\t') value++;
  if (strncmp(value, "true", 4) == 0) return 1;
  if (strncmp(value, "false", 5) == 0) return 0;
  return fallback;
}

static int parse_screen_id(const char *id, ScreenIdentity *identity) {
  if (strncmp(id, "window:", 7) != 0) return 0;
  const char *window_number = id + 7;
  if (*window_number < '0' || *window_number > '9') return 0;
  char *separator;
  errno = 0;
  unsigned long window = strtoul(window_number, &separator, 10);
  if (errno == ERANGE || !window || window > UINT32_MAX || *separator != ':') return 0;
  const char *pid_number = separator + 1;
  if (*pid_number < '0' || *pid_number > '9') return 0;
  errno = 0;
  long process_id = strtol(pid_number, &separator, 10);
  if (errno == ERANGE || process_id <= 0 || process_id > INT_MAX || *separator != ':')
    return 0;
  const char *process_start = separator + 1;
  size_t start_length = strlen(process_start);
  if (!start_length || start_length >= sizeof(identity->process_start)) return 0;
  for (const char *p = process_start; *p; p++)
    if (*p < '0' || *p > '9') return 0;
  identity->window = (Window)window;
  identity->process_id = (pid_t)process_id;
  memcpy(identity->process_start, process_start, start_length + 1);
  return 1;
}

static int process_start_time(pid_t process_id, char *start, size_t start_size) {
  char path[64], line[4096];
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)process_id);
  FILE *stat_file = fopen(path, "r");
  if (!stat_file) return 0;
  int read = fgets(line, sizeof(line), stat_file) != NULL;
  fclose(stat_file);
  if (!read) return 0;
  char *field = strrchr(line, ')');
  if (!field) return 0;
  field++;
  for (int number = 3; number <= 22; number++) {
    while (*field == ' ') field++;
    char *value = field;
    while (*field && *field != ' ' && *field != '\n') field++;
    if (number != 22) {
      if (!*field) return 0;
      continue;
    }
    size_t length = (size_t)(field - value);
    if (!length || length >= start_size) return 0;
    memcpy(start, value, length);
    start[length] = 0;
    return 1;
  }
  return 0;
}

static int window_process_id(Window window, pid_t *process_id) {
  Atom property = XInternAtom(display, "_NET_WM_PID", True);
  if (property == None) return 0;
  Atom type;
  int format;
  unsigned long count, remaining;
  unsigned char *data = NULL;
  int result = XGetWindowProperty(display, window, property, 0, 1, False, XA_CARDINAL,
                                  &type, &format, &count, &remaining, &data);
  if (result != Success || type != XA_CARDINAL || format != 32 || count != 1 || !data) {
    if (data) XFree(data);
    return 0;
  }
  unsigned long value = *(unsigned long *)data;
  XFree(data);
  if (!value || value > INT_MAX) return 0;
  *process_id = (pid_t)value;
  return 1;
}

static int window_matches_id(const ScreenIdentity *identity) {
  pid_t process_id;
  char process_start[32];
  return window_process_id(identity->window, &process_id) && process_id == identity->process_id &&
         process_start_time(process_id, process_start, sizeof(process_start)) &&
         strcmp(process_start, identity->process_start) == 0;
}

static int window_process_identity(Window window, pid_t *process_id, char *process_start,
                                  size_t start_size) {
  return window_process_id(window, process_id) &&
         process_start_time(*process_id, process_start, start_size);
}

static int window_is_viewable(Window window) {
  XWindowAttributes attributes;
  return window && XGetWindowAttributes(display, window, &attributes) &&
         attributes.map_state == IsViewable;
}

static unsigned char pixel_channel(unsigned long pixel, unsigned long mask) {
  if (!mask) return 0;
  int shift = 0;
  while (!(mask & 1)) {
    mask >>= 1;
    shift++;
  }
  unsigned long value = (pixel >> shift) & mask;
  return (unsigned char)((value * 255 + mask / 2) / mask);
}

static void window_title(Window window, char *title, size_t title_size) {
  snprintf(title, title_size, "Window");
  Atom utf8 = XInternAtom(display, "UTF8_STRING", True);
  Atom net_wm_name = XInternAtom(display, "_NET_WM_NAME", True);
  if (utf8 != None && net_wm_name != None) {
    Atom type;
    int format;
    unsigned long count, remaining;
    unsigned char *name = NULL;
    if (XGetWindowProperty(display, window, net_wm_name, 0, (long)(title_size - 1), False,
                           utf8, &type, &format, &count, &remaining, &name) == Success &&
        type == utf8 && format == 8 && name && count) {
      size_t length = count < title_size - 1 ? count : title_size - 1;
      memcpy(title, name, length);
      title[length] = 0;
      XFree(name);
      return;
    }
    if (name) XFree(name);
  }
  char *name = NULL;
  if (XFetchName(display, window, &name) && name) {
    snprintf(title, title_size, "%s", name);
    XFree(name);
  }
}

static void send_capture_state(Capture *capture, const char *status, const char *reason) {
  char state[1024];
  size_t offset = (size_t)snprintf(
    state, sizeof(state),
    "{\"type\":\"state\",\"screenId\":\"%s\",\"status\":\"%s\"",
    capture->id, status);
  if (strcmp(status, "live") == 0) {
    snprintf(state + offset, sizeof(state) - offset, ",\"title\":");
    offset = strlen(state);
    append_json_string(state, sizeof(state), &offset, capture->title);
    snprintf(state + offset, sizeof(state) - offset, ",\"hasControl\":false}");
  } else {
    snprintf(state + offset, sizeof(state) - offset, ",\"reason\":");
    offset = strlen(state);
    append_json_string(state, sizeof(state), &offset, reason);
    snprintf(state + offset, sizeof(state) - offset, "}");
  }
  send_packet(state, NULL, 0);
}

static void window_application(Window window, char *application, size_t application_size) {
  snprintf(application, application_size, "Linux");
  XClassHint hint;
  memset(&hint, 0, sizeof(hint));
  if (XGetClassHint(display, window, &hint)) {
    if (hint.res_name)
      snprintf(application, application_size, "%s", hint.res_name);
    XFree(hint.res_name);
    XFree(hint.res_class);
  }
}

static void encode_jpeg(unsigned char *rgb, int width, int height, int stride,
                        unsigned char **jpeg, unsigned long *jpeg_size) {
  struct jpeg_compress_struct cinfo;
  struct jpeg_error_mgr error;
  cinfo.err = jpeg_std_error(&error);
  jpeg_create_compress(&cinfo);
  jpeg_mem_dest(&cinfo, jpeg, jpeg_size);
  cinfo.image_width = (JDIMENSION)width;
  cinfo.image_height = (JDIMENSION)height;
  cinfo.input_components = 3;
  cinfo.in_color_space = JCS_RGB;
  jpeg_set_defaults(&cinfo);
  jpeg_set_quality(&cinfo, 70, TRUE);
  jpeg_start_compress(&cinfo, TRUE);
  while (cinfo.next_scanline < cinfo.image_height) {
    unsigned char *row = rgb + cinfo.next_scanline * stride;
    jpeg_write_scanlines(&cinfo, &row, 1);
  }
  jpeg_finish_compress(&cinfo);
  jpeg_destroy_compress(&cinfo);
}

static Capture *capture_by_id(const char *id) {
  for (size_t i = 0; i < capture_count; i++)
    if (strcmp(captures[i]->id, id) == 0) return captures[i];
  return NULL;
}

static void *capture_frames(void *opaque) {
  Capture *capture = (Capture *)opaque;
  int live_sent = 0;
  while (atomic_load(&capture->running)) {
    pthread_mutex_lock(&x_lock);
    XWindowAttributes attributes;
    int identity_matches = 1;
    if (capture->sequence % 30 == 0) {
      pid_t process_id;
      char process_start[32];
      identity_matches = window_process_id(capture->window, &process_id) &&
        process_id == capture->process_id &&
        process_start_time(process_id, process_start, sizeof(process_start)) &&
        strcmp(process_start, capture->process_start) == 0;
    }
    if (!identity_matches || !XGetWindowAttributes(display, capture->window, &attributes) ||
        attributes.map_state != IsViewable) {
      pthread_mutex_unlock(&x_lock);
      send_capture_state(capture, "ended", "Screen is unavailable.");
      atomic_store(&capture->running, 0);
      break;
    }
    int width = attributes.width;
    int height = attributes.height;
    int scale_width = atomic_load(&capture->max_width);
    int scale_height = atomic_load(&capture->max_height);
    double scale = scale_width > 0 && scale_height > 0
                     ? fmin(1.0, fmin((double)scale_width / width, (double)scale_height / height))
                     : 1.0;
    int output_width = width > 0 ? (int)(width * scale + 0.5) : 1;
    int output_height = height > 0 ? (int)(height * scale + 0.5) : 1;
    XImage *image = XGetImage(display, capture->window, 0, 0, (unsigned)width, (unsigned)height,
                              AllPlanes, ZPixmap);
    pthread_mutex_unlock(&x_lock);
    if (!image) {
      usleep(33000);
      continue;
    }
    int rgb_stride = output_width * 3;
    unsigned char *rgb = (unsigned char *)malloc((size_t)rgb_stride * output_height);
    if (!rgb) {
      XDestroyImage(image);
      send_capture_state(capture, "ended", "Unable to allocate screen frame.");
      atomic_store(&capture->running, 0);
      break;
    }
    for (int y = 0; y < output_height; y++) {
      int source_y = (int)((double)y * height / output_height);
      unsigned char *row = rgb + y * rgb_stride;
      for (int x = 0; x < output_width; x++) {
        int source_x = (int)((double)x * width / output_width);
        unsigned long pixel = XGetPixel(image, source_x, source_y);
        row[x * 3] = pixel_channel(pixel, image->red_mask);
        row[x * 3 + 1] = pixel_channel(pixel, image->green_mask);
        row[x * 3 + 2] = pixel_channel(pixel, image->blue_mask);
      }
    }
    XDestroyImage(image);
    unsigned char *jpeg = NULL;
    unsigned long jpeg_size = 0;
    encode_jpeg(rgb, output_width, output_height, rgb_stride, &jpeg, &jpeg_size);
    free(rgb);
    if (!jpeg) {
      send_capture_state(capture, "ended", "Unable to encode screen frame.");
      atomic_store(&capture->running, 0);
      break;
    }
    if (!live_sent) {
      send_capture_state(capture, "live", "");
      live_sent = 1;
    }
    capture->sequence++;
    char frame[512];
    snprintf(frame, sizeof(frame),
             "{\"type\":\"frame\",\"screenId\":\"%s\",\"sequence\":%d,\"width\":%d,\"height\":%d}",
             capture->id, capture->sequence, output_width, output_height);
    send_packet(frame, jpeg, jpeg_size);
    if (jpeg) free(jpeg);
    usleep(33000);
  }
  return NULL;
}

static void handle_list(int request_id) {
  pthread_mutex_lock(&x_lock);
  Window root = RootWindow(display, DefaultScreen(display));
  Window root_return, parent, *children = NULL;
  unsigned int child_count = 0;
  XQueryTree(display, root, &root_return, &parent, &children, &child_count);
  char json[65536];
  size_t offset = snprintf(json, sizeof(json),
                           "{\"type\":\"reply\",\"requestId\":%d,\"ok\":true,\"value\":{\"displays\":[],\"windows\":[",
                           request_id);
  int first = 1;
  for (unsigned int i = 0; i < child_count; i++) {
    Window frame = children[i];
    Window frame_root, frame_parent, *clients = NULL;
    unsigned int client_count = 0;
    /* WSLg's XWM reparents each client directly below its root-level frame. */
    XQueryTree(display, frame, &frame_root, &frame_parent, &clients, &client_count);
    for (unsigned int j = 0; j <= client_count; j++) {
      Window window = j == 0 ? frame : clients[j - 1];
      XWindowAttributes attributes;
      if (!XGetWindowAttributes(display, window, &attributes) ||
          attributes.map_state != IsViewable ||
          attributes.width < 40 || attributes.height < 40)
        continue;
      pid_t process_id;
      char process_start[32], screen_id[96];
      if (!window_process_identity(window, &process_id, process_start, sizeof(process_start)))
        continue;
      char title[256], application[128];
      window_title(window, title, sizeof(title));
      window_application(window, application, sizeof(application));
      snprintf(screen_id, sizeof(screen_id), "window:%lu:%ld:%s",
               (unsigned long)window, (long)process_id, process_start);
      offset += (size_t)snprintf(json + offset, sizeof(json) - offset,
                                 "%s{\"id\":\"%s\",\"title\":",
                                 first ? "" : ",", screen_id);
      append_json_string(json, sizeof(json), &offset, title);
      offset += (size_t)snprintf(json + offset, sizeof(json) - offset, ",\"application\":");
      append_json_string(json, sizeof(json), &offset, application);
      offset += (size_t)snprintf(json + offset, sizeof(json) - offset, "}");
      first = 0;
    }
    if (clients) XFree(clients);
  }
  if (children) XFree(children);
  snprintf(json + offset, sizeof(json) - offset, "]}}");
  pthread_mutex_unlock(&x_lock);
  send_packet(json, NULL, 0);
}

static void capture_image(const ScreenIdentity *identity, int width_limit, int height_limit,
                          unsigned char **jpeg, unsigned long *jpeg_size) {
  pthread_mutex_lock(&x_lock);
  XWindowAttributes attributes;
  if (!window_matches_id(identity) ||
      !XGetWindowAttributes(display, identity->window, &attributes) ||
      attributes.map_state != IsViewable) {
    pthread_mutex_unlock(&x_lock);
    return;
  }
  XImage *image = XGetImage(display, identity->window, 0, 0, (unsigned)attributes.width,
                            (unsigned)attributes.height, AllPlanes, ZPixmap);
  pthread_mutex_unlock(&x_lock);
  if (!image) return;
  int width = attributes.width, height = attributes.height;
  double scale = fmin(1.0, fmin((double)width_limit / width, (double)height_limit / height));
  int output_width = (int)(width * scale + 0.5);
  int output_height = (int)(height * scale + 0.5);
  if (output_width < 1) output_width = 1;
  if (output_height < 1) output_height = 1;
  int stride = output_width * 3;
  unsigned char *rgb = (unsigned char *)calloc((size_t)stride * output_height, 1);
  if (!rgb) {
    XDestroyImage(image);
    return;
  }
  for (int y = 0; y < output_height; y++) {
    int source_y = y * height / output_height;
    unsigned char *row = rgb + y * stride;
    for (int x = 0; x < output_width; x++) {
      int source_x = x * width / output_width;
      unsigned long pixel = XGetPixel(image, source_x, source_y);
      row[x * 3] = pixel_channel(pixel, image->red_mask);
      row[x * 3 + 1] = pixel_channel(pixel, image->green_mask);
      row[x * 3 + 2] = pixel_channel(pixel, image->blue_mask);
    }
  }
  XDestroyImage(image);
  encode_jpeg(rgb, output_width, output_height, stride, jpeg, jpeg_size);
  free(rgb);
}

static double json_number(const char *json, const char *key) {
  char needle[128];
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  const char *p = strstr(json, needle);
  if (!p || !(p = strchr(p, ':'))) return 0;
  return strtod(p + 1, NULL);
}

static KeySym key_sym(const char *code) {
  if (strncmp(code, "Key", 3) == 0 && code[3] && !code[4])
    return XStringToKeysym((char[]){(char)(code[3] | 0x20), 0});
  if (strncmp(code, "Digit", 5) == 0 && code[5] && !code[6])
    return XStringToKeysym((char[]){code[5], 0});
  if (strncmp(code, "Numpad", 6) == 0) {
    char name[64];
    snprintf(name, sizeof(name), "KP_%s", code + 6);
    return XStringToKeysym(name);
  }
  static const struct { const char *code; const char *symbol; } keys[] = {
    {"ArrowDown", "Down"}, {"ArrowLeft", "Left"}, {"ArrowRight", "Right"},
    {"ArrowUp", "Up"}, {"Backspace", "BackSpace"}, {"ControlLeft", "Control_L"},
    {"ControlRight", "Control_R"}, {"Delete", "Delete"}, {"End", "End"},
    {"Enter", "Return"}, {"Escape", "Escape"}, {"Home", "Home"},
    {"Insert", "Insert"}, {"MetaLeft", "Super_L"}, {"MetaRight", "Super_R"},
    {"PageDown", "Next"}, {"PageUp", "Prior"}, {"ShiftLeft", "Shift_L"},
    {"ShiftRight", "Shift_R"}, {"Space", "space"}, {"Tab", "Tab"},
    {"AltLeft", "Alt_L"}, {"AltRight", "Alt_R"}
  };
  for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++)
    if (strcmp(code, keys[i].code) == 0) return XStringToKeysym((char *)keys[i].symbol);
  if (code[0] == 'F' && code[1] >= '1' && code[1] <= '9' && !code[2])
    return XStringToKeysym((char *)code);
  if (code[0] == 'F' && code[1] == '1' && code[2] >= '0' && code[2] <= '2' && !code[3])
    return XStringToKeysym((char *)code);
  return NoSymbol;
}

static int move_to_position(Window window, double x, double y) {
  XWindowAttributes attributes;
  if (!XGetWindowAttributes(display, window, &attributes)) return 0;
  int root_x = 0, root_y = 0;
  Window child;
  XTranslateCoordinates(display, window, RootWindow(display, DefaultScreen(display)),
                        0, 0, &root_x, &root_y, &child);
  return XTestFakeMotionEvent(display, DefaultScreen(display),
                              root_x + (int)(x * attributes.width),
                              root_y + (int)(y * attributes.height), CurrentTime);
}

static void release_input(void) {
  for (int key = 0; key < 256; key++) {
    if (!held_keys[key]) continue;
    XTestFakeKeyEvent(display, (KeyCode)key, False, CurrentTime);
    held_keys[key] = 0;
  }
  for (int button = 1; button < 8; button++) {
    if (!held_buttons[button]) continue;
    XTestFakeButtonEvent(display, (unsigned)button, False, CurrentTime);
    held_buttons[button] = 0;
  }
  XFlush(display);
}

static int utf8_codepoint(const unsigned char **text, uint32_t *codepoint) {
  const unsigned char *value = *text;
  uint32_t result;
  size_t length;
  if (value[0] < 0x80) {
    result = value[0];
    length = 1;
  } else if ((value[0] & 0xe0) == 0xc0) {
    result = value[0] & 0x1f;
    length = 2;
  } else if ((value[0] & 0xf0) == 0xe0) {
    result = value[0] & 0x0f;
    length = 3;
  } else if ((value[0] & 0xf8) == 0xf0) {
    result = value[0] & 0x07;
    length = 4;
  } else {
    return 0;
  }
  for (size_t i = 1; i < length; i++) {
    if (!value[i] || (value[i] & 0xc0) != 0x80) return 0;
    result = (result << 6) | (value[i] & 0x3f);
  }
  if ((length == 2 && result < 0x80) ||
      (length == 3 && result < 0x800) ||
      (length == 4 && result < 0x10000) ||
      result > 0x10ffff || (result >= 0xd800 && result <= 0xdfff))
    return 0;
  *text += length;
  *codepoint = result;
  return 1;
}

static int reserve_unicode_keycode(void) {
  if (unicode_keycode) return 1;
  int minimum, maximum, width = 0;
  XDisplayKeycodes(display, &minimum, &maximum);
  KeySym *mapping = XGetKeyboardMapping(display, (KeyCode)minimum, maximum - minimum + 1,
                                        &width);
  if (!mapping || width <= 0) {
    if (mapping) XFree(mapping);
    return 0;
  }
  for (int code = minimum; code <= maximum; code++) {
    int empty = 1;
    for (int column = 0; column < width; column++)
      if (mapping[(code - minimum) * width + column] != NoSymbol) empty = 0;
    if (empty) {
      unicode_keycode = (KeyCode)code;
      unicode_keymap_width = width;
      unicode_keymap = (KeySym *)malloc((size_t)width * sizeof(KeySym));
      if (unicode_keymap)
        memcpy(unicode_keymap, mapping + (code - minimum) * width,
               (size_t)width * sizeof(KeySym));
      else
        unicode_keycode = 0;
      break;
    }
  }
  XFree(mapping);
  return unicode_keycode != 0;
}

/* XTEST sends keycodes, so non-ASCII text temporarily borrows an unused mapping. */
static void notify_keymap(Window window) {
  XEvent event;
  memset(&event, 0, sizeof(event));
  event.xmapping.type = MappingNotify;
  event.xmapping.display = display;
  event.xmapping.request = MappingKeyboard;
  event.xmapping.first_keycode = unicode_keycode;
  event.xmapping.count = 1;
  XSendEvent(display, window, False, NoEventMask, &event);
}

static int map_unicode_keycode(Window window, KeySym symbol) {
  KeySym *mapping = (KeySym *)calloc((size_t)unicode_keymap_width, sizeof(KeySym));
  if (!mapping) return 0;
  mapping[0] = symbol;
  unicode_keymap_window = window;
  unicode_keymap_changed = 1;
  XChangeKeyboardMapping(display, unicode_keycode, unicode_keymap_width, mapping, 1);
  notify_keymap(window);
  XSync(display, False);
  free(mapping);
  return 1;
}

static void restore_unicode_mapping(Window window) {
  if (!unicode_keycode || !unicode_keymap_changed) return;
  XChangeKeyboardMapping(display, unicode_keycode, unicode_keymap_width, unicode_keymap, 1);
  notify_keymap(window);
  XSync(display, False);
  unicode_keymap_changed = 0;
}

static void restore_unicode_keycode(Window window) {
  if (!unicode_keycode) return;
  restore_unicode_mapping(window);
  free(unicode_keymap);
  unicode_keymap = NULL;
  unicode_keymap_width = 0;
  unicode_keycode = 0;
  unicode_keymap_window = None;
}

static void restore_unicode_keymap_at_exit(void) {
  if (unicode_keycode) restore_unicode_keycode(unicode_keymap_window);
}

static int send_key(KeySym symbol, int pressed) {
  KeyCode keycode = XKeysymToKeycode(display, symbol);
  if (!keycode) return 0;
  XTestFakeKeyEvent(display, keycode, pressed, CurrentTime);
  held_keys[keycode] = pressed;
  return 1;
}

static KeySym ascii_key_symbol(unsigned char character) {
  switch (character) {
    case ' ': return XK_space;
    case '-': return XK_minus;
    case '=': return XK_equal;
    case '[': return XK_bracketleft;
    case ']': return XK_bracketright;
    case '\\': return XK_backslash;
    case ';': return XK_semicolon;
    case '\'': return XK_apostrophe;
    case ',': return XK_comma;
    case '.': return XK_period;
    case '/': return XK_slash;
    case '`': return XK_grave;
    default: return XStringToKeysym((char[]){(char)character, 0});
  }
}

static int type_ascii(unsigned char character) {
  if (character == '\n' || character == '\r')
    return send_key(XK_Return, True) && send_key(XK_Return, False);
  if (character == '\t')
    return send_key(XK_Tab, True) && send_key(XK_Tab, False);
  int shifted = 0;
  if (character >= 'A' && character <= 'Z') {
    character = (unsigned char)tolower(character);
    shifted = 1;
  } else {
    const char *shifted_chars = "!@#$%^&*()_+{}|:\"<>?~";
    const char *plain_chars = "1234567890-=[]\\;',./`";
    const char *match = strchr(shifted_chars, character);
    if (match) {
      character = (unsigned char)plain_chars[match - shifted_chars];
      shifted = 1;
    }
  }
  KeySym symbol = ascii_key_symbol(character);
  KeyCode keycode = XKeysymToKeycode(display, symbol);
  if (symbol == NoSymbol || !keycode) return 0;
  KeyCode shift = shifted ? XKeysymToKeycode(display, XK_Shift_L) : 0;
  if (shift && !held_keys[shift]) XTestFakeKeyEvent(display, shift, True, CurrentTime);
  XTestFakeKeyEvent(display, keycode, True, CurrentTime);
  XTestFakeKeyEvent(display, keycode, False, CurrentTime);
  if (shift && !held_keys[shift]) XTestFakeKeyEvent(display, shift, False, CurrentTime);
  return 1;
}

static void send_scroll(double delta, unsigned positive_button, unsigned negative_button,
                        int axis) {
  double total = scroll_remainders[axis] + delta / 40.0;
  int steps = (int)total;
  if (steps > 20) {
    steps = 20;
    scroll_remainders[axis] = 0;
  } else if (steps < -20) {
    steps = -20;
    scroll_remainders[axis] = 0;
  } else {
    scroll_remainders[axis] = total - steps;
  }
  unsigned button = steps > 0 ? positive_button : negative_button;
  for (int i = 0; i < abs(steps); i++) {
    XTestFakeButtonEvent(display, button, True, CurrentTime);
    XTestFakeButtonEvent(display, button, False, CurrentTime);
  }
}

static int send_input_action(Window window, const char *action) {
  char type[32] = "";
  json_string(action, "type", type, sizeof(type));
  if (strcmp(type, "pointer") == 0) {
    double x = json_number(action, "x"), y = json_number(action, "y");
    if (!move_to_position(window, x, y)) return 0;
    char phase[16] = "";
    json_string(action, "phase", phase, sizeof(phase));
    if (strcmp(phase, "down") == 0 || strcmp(phase, "up") == 0) {
      int button = json_int(action, "button");
      if (button < 0 || button > 2) return 0;
      unsigned native_button = button == 0 ? 1 : button == 1 ? 2 : 3;
      int pressed = strcmp(phase, "down") == 0;
      XTestFakeButtonEvent(display, native_button, pressed, CurrentTime);
      held_buttons[native_button] = pressed;
    }
    return 1;
  }
  if (strcmp(type, "scroll") == 0) {
    double dx = json_number(action, "dx"), dy = json_number(action, "dy");
    if (!move_to_position(window, json_number(action, "x"), json_number(action, "y")))
      return 0;
    send_scroll(dy, 5, 4, 0);
    send_scroll(dx, 7, 6, 1);
    return 1;
  }
  if (strcmp(type, "key") == 0) {
    char code[64] = "";
    json_string(action, "code", code, sizeof(code));
    KeySym symbol = key_sym(code);
    KeyCode keycode = symbol == NoSymbol ? 0 : XKeysymToKeycode(display, symbol);
    if (!keycode) return 0;
    int pressed = json_bool(action, "down", 0);
    XTestFakeKeyEvent(display, keycode, pressed, CurrentTime);
    held_keys[keycode] = pressed;
    return 1;
  }
  if (strcmp(type, "text") == 0) {
    char text[16385] = "";
    json_string(action, "text", text, sizeof(text));
    int needs_unicode = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p;) {
      uint32_t codepoint;
      if (!utf8_codepoint(&p, &codepoint)) return 0;
      if (codepoint >= 0x80) needs_unicode = 1;
    }
    if (needs_unicode && !reserve_unicode_keycode()) return 0;
    const unsigned char *p = (const unsigned char *)text;
    int success = 1;
    while (*p && success) {
      uint32_t codepoint;
      if (!utf8_codepoint(&p, &codepoint)) {
        success = 0;
        break;
      }
      if (codepoint < 0x80) {
        if (codepoint == '\r' && *p == '\n') p++;
        success = type_ascii((unsigned char)codepoint);
        continue;
      }
      KeySym symbol = codepoint <= 0xff
                        ? (KeySym)codepoint
                        : (KeySym)(0x01000000u | codepoint);
      if (!map_unicode_keycode(window, symbol)) {
        success = 0;
        break;
      }
      XTestFakeKeyEvent(display, unicode_keycode, True, CurrentTime);
      XTestFakeKeyEvent(display, unicode_keycode, False, CurrentTime);
      XSync(display, False);
      restore_unicode_mapping(window);
      usleep(10000);
    }
    restore_unicode_keycode(window);
    XFlush(display);
    return success;
  }
  return 0;
}

static int send_input_actions(Window window, const char *line) {
  const char *actions = strstr(line, "\"actions\"");
  if (!actions || !(actions = strchr(actions, '['))) return 0;
  actions++;
  int count = 0;
  while (*actions && *actions != ']') {
    if (*actions != '{') {
      actions++;
      continue;
    }
    const char *start = actions++;
    int depth = 1, quoted = 0, escaped = 0;
    while (*actions && depth) {
      char current = *actions++;
      if (quoted) {
        if (escaped) escaped = 0;
        else if (current == '\\') escaped = 1;
        else if (current == '"') quoted = 0;
      } else if (current == '"') quoted = 1;
      else if (current == '{') depth++;
      else if (current == '}') depth--;
    }
    if (depth) return 0;
    size_t length = (size_t)(actions - start);
    char *action = (char *)malloc(length + 1);
    if (!action) return 0;
    memcpy(action, start, length);
    action[length] = 0;
    int sent = send_input_action(window, action);
    free(action);
    if (!sent) return 0;
    count++;
  }
  XFlush(display);
  return count > 0;
}

static void handle_request(char *line) {
  int request_id = json_int(line, "id");
  char method[64] = "", screen_id[96] = "";
  json_string(line, "method", method, sizeof(method));
  json_string(line, "screenId", screen_id, sizeof(screen_id));
  if (strcmp(method, "list") == 0) {
    handle_list(request_id);
    return;
  }
  if (strcmp(method, "thumbnail") == 0) {
    ScreenIdentity identity;
    unsigned char *jpeg = NULL;
    unsigned long jpeg_size = 0;
    int size = json_int(line, "size");
    pthread_mutex_lock(&x_lock);
    int viewable = parse_screen_id(screen_id, &identity) &&
                   window_matches_id(&identity) && window_is_viewable(identity.window);
    pthread_mutex_unlock(&x_lock);
    if (viewable && size > 0)
      capture_image(&identity, size, size, &jpeg, &jpeg_size);
    if (!jpeg) {
      send_reply(request_id, 0, "Screen is unavailable.", NULL, 0);
      return;
    }
    send_reply(request_id, 1, "", jpeg, jpeg_size);
    free(jpeg);
    return;
  }
  if (strcmp(method, "start") == 0) {
    ScreenIdentity identity;
    if (!parse_screen_id(screen_id, &identity)) {
      send_reply(request_id, 0, "Missing or duplicate screen.", NULL, 0);
      return;
    }
    char title[256];
    pthread_mutex_lock(&x_lock);
    int viewable = window_matches_id(&identity) && window_is_viewable(identity.window);
    if (viewable) window_title(identity.window, title, sizeof(title));
    pthread_mutex_unlock(&x_lock);
    if (!viewable) {
      send_reply(request_id, 0, "Screen is unavailable.", NULL, 0);
      return;
    }
    if (capture_by_id(screen_id)) {
      send_reply(request_id, 0, "Missing or duplicate screen.", NULL, 0);
      return;
    }
    Capture *capture = (Capture *)calloc(1, sizeof(Capture));
    if (!capture) {
      send_reply(request_id, 0, "Unable to allocate screen capture.", NULL, 0);
      return;
    }
    capture->window = identity.window;
    capture->process_id = identity.process_id;
    snprintf(capture->process_start, sizeof(capture->process_start), "%s",
             identity.process_start);
    snprintf(capture->title, sizeof(capture->title), "%s", title);
    atomic_init(&capture->max_width, json_int(line, "width"));
    atomic_init(&capture->max_height, json_int(line, "height"));
    snprintf(capture->id, sizeof(capture->id), "%s", screen_id);
    atomic_init(&capture->running, 1);
    Capture **next = (Capture **)realloc(captures, (capture_count + 1) * sizeof(Capture *));
    if (!next) {
      free(capture);
      send_reply(request_id, 0, "Unable to allocate screen capture.", NULL, 0);
      return;
    }
    captures = next;
    captures[capture_count++] = capture;
    int thread_error = pthread_create(&capture->thread, NULL, capture_frames, capture);
    if (thread_error) {
      capture_count--;
      free(capture);
      send_reply(request_id, 0, "Unable to start screen capture.", NULL, 0);
      return;
    }
    capture->thread_started = 1;
    send_reply(request_id, 1, capture->title, NULL, 0);
    return;
  }
  if (strcmp(method, "resize") == 0) {
    Capture *capture = capture_by_id(screen_id);
    if (!capture) {
      send_reply(request_id, 0, "Screen is unavailable.", NULL, 0);
      return;
    }
    atomic_store(&capture->max_width, json_int(line, "width"));
    atomic_store(&capture->max_height, json_int(line, "height"));
    send_reply(request_id, 1, "", NULL, 0);
    return;
  }
  if (strcmp(method, "stop") == 0) {
    Capture *capture = capture_by_id(screen_id);
    if (capture) {
      size_t index = 0;
      while (index < capture_count && captures[index] != capture) index++;
      atomic_store(&capture->running, 0);
      if (capture->thread_started) pthread_join(capture->thread, NULL);
      free(capture);
      if (index + 1 < capture_count)
        memmove(&captures[index], &captures[index + 1],
                (capture_count - index - 1) * sizeof(Capture *));
      capture_count--;
    }
    send_reply(request_id, 1, "", NULL, 0);
    return;
  }
  if (strcmp(method, "focus") == 0) {
    ScreenIdentity identity;
    if (!parse_screen_id(screen_id, &identity)) {
      send_reply(request_id, 0, "Screen is unavailable.", NULL, 0);
      return;
    }
    pthread_mutex_lock(&x_lock);
    if (!window_matches_id(&identity) || !window_is_viewable(identity.window)) {
      pthread_mutex_unlock(&x_lock);
      send_reply(request_id, 0, "Screen is unavailable.", NULL, 0);
      return;
    }
    release_input();
    XRaiseWindow(display, identity.window);
    XSetInputFocus(display, identity.window, RevertToParent, CurrentTime);
    XFlush(display);
    pthread_mutex_unlock(&x_lock);
    send_reply(request_id, 1, "", NULL, 0);
    return;
  }
  if (strcmp(method, "releaseInput") == 0) {
    pthread_mutex_lock(&x_lock);
    release_input();
    pthread_mutex_unlock(&x_lock);
    send_reply(request_id, 1, "", NULL, 0);
    return;
  }
  if (strcmp(method, "input") == 0) {
    ScreenIdentity identity;
    if (!parse_screen_id(screen_id, &identity)) {
      send_reply(request_id, 0, "Screen is unavailable.", NULL, 0);
      return;
    }
    pthread_mutex_lock(&x_lock);
    int sent = window_matches_id(&identity) &&
               window_is_viewable(identity.window) &&
               send_input_actions(identity.window, line);
    pthread_mutex_unlock(&x_lock);
    if (!sent) {
      send_reply(request_id, 0, "Unable to deliver screen input.", NULL, 0);
      return;
    }
    send_reply(request_id, 1, "", NULL, 0);
    return;
  }
  send_reply(request_id, 0, "Unsupported screen command.", NULL, 0);
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  signal(SIGINT, SIG_IGN);
  XInitThreads();
  display = XOpenDisplay(NULL);
  if (!display) {
    fprintf(stderr, "Unable to open the XWayland display.\n");
    return 1;
  }
  if (atexit(restore_unicode_keymap_at_exit) != 0) {
    fprintf(stderr, "Unable to register Unicode keymap cleanup.\n");
    XCloseDisplay(display);
    return 1;
  }
  XSetErrorHandler(ignore_x_error);
  int event_base, error_base, major, minor;
  if (!XTestQueryExtension(display, &event_base, &error_base, &major, &minor)) {
    fprintf(stderr, "The XWayland display does not support XTEST input.\n");
    XCloseDisplay(display);
    return 1;
  }
  char *line = NULL;
  size_t capacity = 0;
  ssize_t length;
  while ((length = getline(&line, &capacity, stdin)) >= 0) {
    if (length && line[length - 1] == '\n') line[length - 1] = 0;
    handle_request(line);
  }
  for (size_t i = 0; i < capture_count; i++) {
    atomic_store(&captures[i]->running, 0);
    pthread_join(captures[i]->thread, NULL);
    free(captures[i]);
  }
  pthread_mutex_lock(&x_lock);
  restore_unicode_keycode(unicode_keymap_window);
  release_input();
  pthread_mutex_unlock(&x_lock);
  free(captures);
  free(line);
  XCloseDisplay(display);
  return 0;
}
