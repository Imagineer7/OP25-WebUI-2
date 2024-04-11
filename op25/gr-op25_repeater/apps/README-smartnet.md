Motorola Smartnet Support
-------------------------
This is experimental, use at your own risk and sanity!

Configuration
-------------
The Smartnet decoder is part of multi_rx.py, so configuration requires the creation of a .json file based smartnet_example.json.  The latter is probably more useful as a starting point since it is solely focussed on trunking using commonly available RTL sdr hardware.

In the .json file, a "channel" is considered to be the receiver as it encapsulates demodulation, framing and decoding in one logical entity.  For a Smartnet system there will be a minimum of two "channel" entries and either one or two "device" entries depending on the hardware you are using.  Each channel is associated with a device by specifying the device name inside the channel definition.  SDR hardware with a high sample rate can be shared between channels, but only if tuning is disabled (tunable=false).  Tunable devices have to have a one-to-one relationship with the channel to which they are assigned.

Trunking requires configuration of the appropriate trunking module name ("tk_smartnet.py"), the control channel list and bandplan. Valid values for the 'bandplan' parameter are:  800_reband, 800_standard, 800_splinter, 900, 400.  The 400Mhz band requires additional configuration of bp_low, bp_high, bp_offet, bp_spacing parameters.

Control over which tgids are candidates for monitoring is via the 'blacklist' and 'whitelist' parameters associated with each of the voice channel(s).  These parameters take the name of a file which contains tgids in the same format as used by rx.py blacklist/whitelist; either a single numeric tgid per line, or a pair of tgids separated by a <tab> character, denoting the start and end of a range.  Each voice channel would normally have it's own non-overlapping blacklist/whitelist definitions to avoid the same audio being played simultaneously.

multi_rx.py has support for enabling a built-in audio player. See the "audio" section of the smartnet-example.json for configuration parameter syntax.  Note that the "instance_name" must be specified for the player to be enabled.  Leaving this parameter absent or blank will cause the player to be disabled.  Consistent configuration of the "udp_port" parameter is required between the audio player and the channel destinations.  Default port is 23456.

Bandplan
--------
Motorola Smartnet/Smartzone systems send a channel identifier command in their group voice grant messaging to identify the actual voice frequency being used.  Translation of this numeric id to an actual frequency depends on the setting of the "bandplan" trunking parameter in conjunction wit the seven associated parameters "bp_spacing", "bp_base", "bp_base_offset", "bp_mid", "bp_mid_offset", "bp_high", "bp_high_offset".  In the USA, most legacy 800Mhz systems should be configured with bandplan set to '800_reband' with no further information necessary, whereas and VHF/UHF systems need to be set to "400" along with the frequency and offset data found under "Custom Frequency Tables" in the Radio Reference Database.

Example 1:
Anne Arundel County (https://www.radioreference.com/apps/db/?sid=187)
    "control_channel_list": "854.4125",
    "bandplan": "800_reband",

Example 2:
Bell Fleetnet Ontario (https://www.radioreference.com/apps/db/?sid=2560)
    "control_channel_list": "142.500",
    "bandplan": "400",
    "bp_spacing": 0.015,
    "bp_base": 141.015,
    "bp_base_offset": 380,
    "bp_mid": 151.730,
    "bp_mid_offset": 579,
    "bp_high": 154.320,
    "bp_high_offset": 632

Startup
-------
Much like op25's rx.py, multi_rx.py is best started using a shell script.
     ./multi_rx.py -v 9 -c smartnet_example.json 2> stderr.2


Known Issues & Limitations
--------------------------
There is currently no support for 'f' or 't' terminal commands
